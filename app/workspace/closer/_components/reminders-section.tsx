"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardAction,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import {
  BellIcon,
  PhoneIcon,
  MessageSquareIcon,
  CheckCircleIcon,
  AlertCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  getReminderUrgency,
  getUrgencyStyles,
  type ReminderUrgency,
} from "./reminder-urgency";

const TICK_INTERVAL_MS = 30_000;

type EnrichedReminder = {
  _id: Id<"followUps">;
  contactMethod?: "call" | "text";
  reminderScheduledAt?: number;
  reminderNote?: string;
  leadName: string;
  leadPhone: string | null;
};

/**
 * Reminders panel — single card with a scrollable list of active reminders.
 *
 * Designed to sit beside the FeaturedMeetingCard in a side-by-side layout.
 * Clicking a reminder opens a detail dialog where the closer can leave an
 * outcome note and mark the reminder complete.
 */
export function RemindersSection() {
  const reminders = useQuery(api.closer.followUpQueries.getActiveReminders);
  const [now, setNow] = useState(() => Date.now());
  const [selectedReminder, setSelectedReminder] =
    useState<EnrichedReminder | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  if (!reminders || reminders.length === 0) return null;

  return (
    <>
      <Card className="flex flex-col">
        <CardHeader>
          <div className="flex items-center gap-2">
            <BellIcon className="size-4 text-muted-foreground" />
            <CardTitle>Reminders</CardTitle>
          </div>
          <CardAction>
            <Badge variant="secondary">{reminders.length}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex-1 p-0">
          <div className="max-h-[280px] overflow-y-auto">
            {reminders.map((reminder, index) => {
              const urgency = getReminderUrgency(
                reminder.reminderScheduledAt ?? 0,
                now,
              );
              return (
                <div key={reminder._id}>
                  {index > 0 && <Separator />}
                  <ReminderListItem
                    reminder={reminder}
                    urgency={urgency}
                    onClick={() => setSelectedReminder(reminder)}
                  />
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <ReminderDetailDialog
        reminder={selectedReminder}
        now={now}
        onClose={() => setSelectedReminder(null)}
      />
    </>
  );
}

/**
 * Compact list row for a single reminder. Clickable to open detail dialog.
 */
function ReminderListItem({
  reminder,
  urgency,
  onClick,
}: {
  reminder: EnrichedReminder;
  urgency: ReminderUrgency;
  onClick: () => void;
}) {
  const MethodIcon =
    reminder.contactMethod === "text" ? MessageSquareIcon : PhoneIcon;
  const urgencyLabel =
    urgency === "red" ? "Overdue" : urgency === "amber" ? "Now" : "Due";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        urgency === "red" && "bg-red-50 dark:bg-red-950/20",
        urgency === "amber" && "bg-amber-50 dark:bg-amber-950/20",
      )}
    >
      {/* Urgency dot */}
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          urgency === "red" && "bg-red-500",
          urgency === "amber" && "bg-amber-500",
          urgency === "normal" && "bg-muted-foreground/40",
        )}
        aria-hidden="true"
      />

      {/* Lead name + method */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{reminder.leadName}</p>
        {reminder.reminderScheduledAt && (
          <p className="text-xs text-muted-foreground">
            {new Date(reminder.reminderScheduledAt).toLocaleString([], {
              dateStyle: "short",
              timeStyle: "short",
            })}
          </p>
        )}
      </div>

      {/* Contact method + urgency badge */}
      <Badge
        variant={
          urgency === "red"
            ? "destructive"
            : urgency === "amber"
              ? "outline"
              : "secondary"
        }
        className="shrink-0"
      >
        <MethodIcon className="mr-1 size-3" />
        {reminder.contactMethod === "text" ? "Text" : "Call"}
        {" · "}
        {urgencyLabel}
      </Badge>
    </button>
  );
}

/**
 * Detail dialog for a single reminder.
 * Shows full info and lets the closer add an outcome note before marking complete.
 */
const completionSchema = z.object({
  completionNote: z.string().optional(),
});
type CompletionFormValues = z.infer<typeof completionSchema>;

function ReminderDetailDialog({
  reminder,
  now,
  onClose,
}: {
  reminder: EnrichedReminder | null;
  now: number;
  onClose: () => void;
}) {
  const markComplete = useMutation(
    api.closer.followUpMutations.markReminderComplete,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm({
    resolver: standardSchemaResolver(completionSchema),
    defaultValues: { completionNote: "" },
  });

  // Reset form when dialog opens with a new reminder
  useEffect(() => {
    if (reminder) {
      form.reset({ completionNote: "" });
      setSubmitError(null);
    }
  }, [reminder, form]);

  const onSubmit = async (values: CompletionFormValues) => {
    if (!reminder) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await markComplete({
        followUpId: reminder._id,
        completionNote: values.completionNote || undefined,
      });
      toast.success("Reminder marked as complete");
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to mark complete",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const urgency = reminder
    ? getReminderUrgency(reminder.reminderScheduledAt ?? 0, now)
    : "normal";
  const MethodIcon =
    reminder?.contactMethod === "text" ? MessageSquareIcon : PhoneIcon;

  return (
    <Dialog open={reminder !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{reminder?.leadName ?? "Reminder"}</DialogTitle>
        </DialogHeader>

        {reminder && (
          <div className="flex flex-col gap-4">
            {/* Contact info */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <MethodIcon className="size-4" />
                <span>
                  {reminder.contactMethod === "text" ? "Text" : "Call"}
                </span>
                <span className="text-muted-foreground/50">·</span>
                <Badge
                  variant={
                    urgency === "red"
                      ? "destructive"
                      : urgency === "amber"
                        ? "outline"
                        : "secondary"
                  }
                >
                  {urgency === "red"
                    ? "Overdue"
                    : urgency === "amber"
                      ? "Due now"
                      : "Upcoming"}
                </Badge>
              </div>

              {/* Phone — prominent + clickable */}
              {reminder.leadPhone && (
                <a
                  href={`tel:${reminder.leadPhone}`}
                  className="text-lg font-semibold text-primary hover:underline"
                >
                  {reminder.leadPhone}
                </a>
              )}

              {/* Scheduled time */}
              {reminder.reminderScheduledAt && (
                <p className="text-sm text-muted-foreground">
                  {new Date(reminder.reminderScheduledAt).toLocaleString([], {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              )}
            </div>

            {/* Original note */}
            {reminder.reminderNote && (
              <div className="rounded-md bg-muted px-3 py-2">
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  Note
                </p>
                <p className="text-sm">{reminder.reminderNote}</p>
              </div>
            )}

            <Separator />

            {/* Completion form */}
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="flex flex-col gap-4"
              >
                <FormField
                  control={form.control}
                  name="completionNote"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Outcome (optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          placeholder="e.g., Spoke with lead, they'll book next week..."
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

                <DialogFooter>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={onClose}
                    disabled={isSubmitting}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? (
                      <>
                        <Spinner data-icon="inline-start" />
                        Completing...
                      </>
                    ) : (
                      <>
                        <CheckCircleIcon data-icon="inline-start" />
                        Mark Complete
                      </>
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
