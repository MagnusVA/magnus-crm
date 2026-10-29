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

type AdminFollowUpDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  onSuccess?: () => Promise<void>;
  /** Controlled open state. When set, the dialog renders no trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Named in the dialog so the admin knows whose deal moves. */
  leadName?: string | null;
};

type DialogPath = "selection" | "scheduling_link" | "manual_reminder";

/**
 * Admin Follow-Up Dialog — same two-path UI as the closer version,
 * but calls admin mutations which use the assigned closer's Calendly URI.
 */
export function AdminFollowUpDialog({
  opportunityId,
  meetingId,
  onSuccess,
  open: controlledOpen,
  onOpenChange,
  leadName,
}: AdminFollowUpDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    if (!isControlled) setInternalOpen(value);
    onOpenChange?.(value);
  };
  const [path, setPath] = useState<DialogPath>("selection");
  // A scheduling link was generated and the deal hasn't moved to Follow-up yet.
  const [pendingFollowUpId, setPendingFollowUpId] =
    useState<Id<"followUps"> | null>(null);
  const linkPending = pendingFollowUpId !== null;
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const confirmFollowUp = useMutation(
    api.admin.meetingActions.adminConfirmFollowUp,
  );

  const closeDialog = () => {
    setOpen(false);
    setPendingFollowUpId(null);
    setConfirmError(null);
    setTimeout(() => setPath("selection"), 200);
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
      console.error("[AdminFollowUpDialog] adminConfirmFollowUp failed", err);
      setConfirmError(
        getErrorMessage(
          err,
          "The link was generated, but the deal didn't move to Follow-up.",
        ),
      );
      setConfirming(false);
      return;
    }
    // The deal moved. A failing refresh afterwards isn't a failed confirm.
    try {
      await onSuccess?.();
    } catch (err: unknown) {
      console.error("[AdminFollowUpDialog] refresh after confirm failed", err);
    }
    setConfirming(false);
    closeDialog();
  };

  const handleOpenChange = (value: boolean) => {
    if (value) {
      setOpen(true);
      return;
    }
    if (confirming) {
      return;
    }
    // Closing after Generate counts as Done, as in the closer's dialog.
    if (linkPending && confirmError === null) {
      void confirmAndClose();
      return;
    }
    closeDialog();
  };

  const handleClose = () => {
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {isControlled ? null : (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <CalendarPlusIcon data-icon="inline-start" />
            Schedule follow-up
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {path === "selection" && "Schedule follow-up"}
            {path === "scheduling_link" && "Send scheduling link"}
            {path === "manual_reminder" && "Set a reminder"}
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
          <AdminSchedulingLinkForm
            opportunityId={opportunityId}
            onGenerated={setPendingFollowUpId}
            onDone={confirmAndClose}
            confirming={confirming}
            confirmError={confirmError}
            onClose={handleClose}
          />
        )}

        {path === "manual_reminder" && (
          <AdminManualReminderForm
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
            Generate a scheduling link using the assigned closer&apos;s
            Calendly.
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
            Set a reminder for the closer to call or text the lead.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Admin scheduling link form — calls admin mutations, uses assigned closer's Calendly URI.
 * Done (or closing the dialog) moves the deal through `AdminFollowUpDialog`.
 */
function AdminSchedulingLinkForm({
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
    "idle",
  );
  const [schedulingLinkUrl, setSchedulingLinkUrl] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createFollowUp = useMutation(
    api.admin.meetingActions.adminCreateFollowUp,
  );

  const handleGenerate = async () => {
    setState("loading");
    setError(null);
    try {
      const result = await createFollowUp({ opportunityId });
      setSchedulingLinkUrl(result.schedulingLinkUrl);
      onGenerated(result.followUpId);
      posthog.capture("admin_follow_up_scheduling_link_created", {
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
      posthog.capture("admin_follow_up_link_copied", {
        opportunity_id: opportunityId,
      });
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (state === "idle") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Generate a scheduling link using the assigned closer&apos;s Calendly
          event type. Copy and share it with the lead.
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
        <Button
          variant="outline"
          onClick={() => void onDone()}
          disabled={confirming}
        >
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
 * Admin manual reminder form — calls admin mutation for creating reminders.
 */
const reminderSchema = z.object({
  contactMethod: z.enum(["call", "text"]),
  reminderDate: z.string().min(1, "Date is required"),
  reminderTime: z.string().min(1, "Time is required"),
  note: z.string().optional(),
});
type ReminderFormValues = z.infer<typeof reminderSchema>;

function AdminManualReminderForm({
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
    api.admin.meetingActions.adminCreateManualReminder,
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
      const reminderScheduledAt = new Date(
        `${values.reminderDate}T${values.reminderTime}`,
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
      posthog.capture("admin_follow_up_reminder_created", {
        opportunity_id: opportunityId,
        meeting_id: meetingId ?? null,
        contact_method: values.contactMethod,
      });
      toast.success("Reminder created");
      onClose();
    } catch (err: unknown) {
      setSubmitError(
        getErrorMessage(err, "Failed to create reminder."),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-4"
      >
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
