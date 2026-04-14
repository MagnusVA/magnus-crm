"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import {
  ClockIcon,
  AlertCircleIcon,
  CalendarDaysIcon,
  TimerIcon,
} from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { format } from "date-fns";

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

const resolveMeetingSchema = z
  .object({
    startTime: z.string().min(1, "Start time is required"),
    endTime: z.string().min(1, "End time is required"),
  })
  .refine(
    (data) => {
      if (!data.startTime || !data.endTime) return true;
      return new Date(data.startTime).getTime() < new Date(data.endTime).getTime();
    },
    { message: "Start time must be before end time", path: ["endTime"] },
  )
  .refine(
    (data) => {
      if (!data.endTime) return true;
      return new Date(data.endTime).getTime() <= Date.now() + 60_000;
    },
    { message: "End time cannot be in the future", path: ["endTime"] },
  );

type ResolveMeetingFormValues = z.infer<typeof resolveMeetingSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Date to `YYYY-MM-DDTHH:mm` for datetime-local inputs. */
function toLocalDatetimeString(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format a duration in minutes into a human-readable string. */
function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainder = mins % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type AdminResolveMeetingDialogProps = {
  meetingId: Id<"meetings">;
  scheduledAt: number;
  durationMinutes: number;
};

/**
 * Admin Resolve Meeting Dialog — retroactively set actual meeting start/end
 * times for a `scheduled` meeting the closer didn't start.
 *
 * After resolving, the opportunity transitions to `in_progress`, unlocking
 * outcome actions (Log Payment, Mark Lost, Follow-up) in the AdminActionBar.
 */
export function AdminResolveMeetingDialog({
  meetingId,
  scheduledAt,
  durationMinutes,
}: AdminResolveMeetingDialogProps) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const resolveMeeting = useMutation(
    api.admin.meetingActions.adminResolveMeeting,
  );

  // Pre-fill with scheduled times as sensible defaults
  const scheduledDate = new Date(scheduledAt);
  const scheduledEndDate = new Date(scheduledAt + durationMinutes * 60_000);

  const form = useForm({
    resolver: standardSchemaResolver(resolveMeetingSchema),
    defaultValues: {
      startTime: toLocalDatetimeString(scheduledDate),
      endTime: toLocalDatetimeString(scheduledEndDate),
    },
  });

  // Compute live duration preview from watched values
  const startTimeValue = form.watch("startTime");
  const endTimeValue = form.watch("endTime");
  const durationPreview = (() => {
    if (!startTimeValue || !endTimeValue) return null;
    const startMs = new Date(startTimeValue).getTime();
    const endMs = new Date(endTimeValue).getTime();
    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) return null;
    return formatDuration(endMs - startMs);
  })();

  const onSubmit = async (values: ResolveMeetingFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await resolveMeeting({
        meetingId,
        startedAt: new Date(values.startTime).getTime(),
        stoppedAt: new Date(values.endTime).getTime(),
      });
      posthog.capture("admin_meeting_resolved", {
        meeting_id: meetingId,
      });
      toast.success("Meeting resolved — you can now log the outcome.");
      setOpen(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to resolve meeting";
      setSubmitError(message);
      posthog.captureException(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Button variant="default" size="sm" onClick={() => setOpen(true)}>
        <ClockIcon data-icon="inline-start" />
        Resolve Meeting
      </Button>

      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!isSubmitting) {
            setOpen(value);
            if (!value) {
              form.reset();
              setSubmitError(null);
            }
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <TimerIcon className="size-4 text-primary" />
              </div>
              <div className="flex-1">
                <DialogTitle>Resolve Meeting Timing</DialogTitle>
                <DialogDescription>
                  Set the actual start and end times for this meeting. This will
                  unlock outcome actions (Log Payment, Mark Lost, etc.)
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* Context banner — scheduled time reference */}
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
            <CalendarDaysIcon className="size-4 shrink-0" />
            <span>
              Scheduled for{" "}
              <span className="font-medium text-foreground">
                {format(scheduledDate, "MMM d, h:mm a")}
              </span>
              {" · "}
              {durationMinutes} min
            </span>
          </div>

          {submitError && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
              <FieldGroup>
                {/* Start Time */}
                <FormField
                  control={form.control}
                  name="startTime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Actual Start Time{" "}
                        <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="datetime-local"
                          disabled={isSubmitting}
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        When the closer actually joined the meeting
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* End Time */}
                <FormField
                  control={form.control}
                  name="endTime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Actual End Time{" "}
                        <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="datetime-local"
                          disabled={isSubmitting}
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        When the meeting actually ended
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FieldGroup>

              {/* Duration preview */}
              {durationPreview && (
                <div className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <TimerIcon className="size-3.5" />
                  <span>
                    Actual duration:{" "}
                    <span className="font-medium text-foreground">
                      {durationPreview}
                    </span>
                  </span>
                </div>
              )}

              <DialogFooter className="mt-5">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      Resolving...
                    </>
                  ) : (
                    "Resolve Meeting"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
