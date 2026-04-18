"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { CalendarClockIcon, ExternalLinkIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  MAX_MEETING_DURATION_MS,
  MIN_START_BEFORE_SCHEDULED_MS,
} from "@/convex/lib/manualMeetingTimes";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

type AcknowledgeWithTimesSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reviewId: Id<"meetingReviews">;
  scheduledAt: number;
  durationMinutes: number;
  fathomLink?: string;
};

function parseLocalDateTime(value: string): number {
  return new Date(value).valueOf();
}

function formatForInput(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildSchema(scheduledAt: number) {
  return z
    .object({
      startedAt: z.string().min(1, "Start time is required."),
      stoppedAt: z.string().min(1, "End time is required."),
      note: z.string().optional(),
    })
    .superRefine((values, ctx) => {
      const start = parseLocalDateTime(values.startedAt);
      const end = parseLocalDateTime(values.stoppedAt);

      if (Number.isNaN(start)) {
        ctx.addIssue({
          code: "custom",
          path: ["startedAt"],
          message: "Enter a valid start time.",
        });
      }

      if (Number.isNaN(end)) {
        ctx.addIssue({
          code: "custom",
          path: ["stoppedAt"],
          message: "Enter a valid end time.",
        });
      }

      if (Number.isNaN(start) || Number.isNaN(end)) {
        return;
      }

      if (start >= end) {
        ctx.addIssue({
          code: "custom",
          path: ["stoppedAt"],
          message: "End time must be after start time.",
        });
      }

      if (start < scheduledAt - MIN_START_BEFORE_SCHEDULED_MS) {
        ctx.addIssue({
          code: "custom",
          path: ["startedAt"],
          message: "Start time cannot be more than 60 minutes before scheduled.",
        });
      }

      if (end > Date.now()) {
        ctx.addIssue({
          code: "custom",
          path: ["stoppedAt"],
          message: "End time cannot be in the future.",
        });
      }

      if (end - start > MAX_MEETING_DURATION_MS) {
        ctx.addIssue({
          code: "custom",
          path: ["stoppedAt"],
          message: "Duration cannot exceed 8 hours.",
        });
      }
    });
}

export function AcknowledgeWithTimesSheet({
  open,
  onOpenChange,
  reviewId,
  scheduledAt,
  durationMinutes,
  fathomLink,
}: AcknowledgeWithTimesSheetProps) {
  const router = useRouter();
  const resolveReview = useMutation(api.reviews.mutations.resolveReview);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const schema = buildSchema(scheduledAt);
  const scheduledEndAt = scheduledAt + durationMinutes * 60_000;
  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "your local time zone";

  const form = useForm({
    resolver: standardSchemaResolver(schema),
    defaultValues: {
      startedAt: formatForInput(scheduledAt),
      stoppedAt: formatForInput(scheduledEndAt),
      note: "",
    },
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    form.reset({
      startedAt: formatForInput(scheduledAt),
      stoppedAt: formatForInput(scheduledEndAt),
      note: "",
    });
    setSubmitError(null);
  }, [durationMinutes, form, open, scheduledAt, scheduledEndAt]);

  const handleSubmit = async (values: {
    startedAt: string;
    stoppedAt: string;
    note?: string;
  }) => {
    setSubmitError(null);

    try {
      await resolveReview({
        reviewId,
        resolutionAction: "acknowledged",
        manualStartedAt: parseLocalDateTime(values.startedAt),
        manualStoppedAt: parseLocalDateTime(values.stoppedAt),
        resolutionNote: values.note?.trim() || undefined,
      });

      onOpenChange(false);
      router.refresh();
      toast.success("Meeting times recorded and review acknowledged.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not save meeting times";
      setSubmitError(message);
      toast.error(message);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (form.formState.isSubmitting) {
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-[520px]">
        <SheetHeader>
          <SheetTitle>Acknowledge with actual times</SheetTitle>
          <SheetDescription>
            Verify the Fathom recording and enter the real meeting start and end
            times. These become the authoritative timestamps on the meeting.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-4 px-4 pb-4">
          {fathomLink ? (
            <Alert>
              <CalendarClockIcon className="size-4" />
              <AlertDescription>
                <a
                  href={fathomLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-medium text-primary underline-offset-4 hover:underline"
                >
                  Open Fathom recording
                  <ExternalLinkIcon className="size-3.5" aria-hidden />
                </a>
              </AlertDescription>
            </Alert>
          ) : (
            <Alert>
              <CalendarClockIcon className="size-4" />
              <AlertDescription>
                No Fathom link is saved on this meeting. Verify the times from
                your other attendance evidence before acknowledging.
              </AlertDescription>
            </Alert>
          )}

          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSubmit)}
              className="flex flex-1 flex-col gap-4"
            >
              {submitError && (
                <Alert variant="destructive">
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}

              <FormField
                control={form.control}
                name="startedAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Meeting started at{" "}
                      <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="datetime-local"
                        disabled={form.formState.isSubmitting}
                      />
                    </FormControl>
                    <FormDescription>
                      Interpreted in {timeZone}.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="stoppedAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Meeting ended at{" "}
                      <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="datetime-local"
                        disabled={form.formState.isSubmitting}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="note"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Resolution note</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        value={field.value ?? ""}
                        placeholder="Optional context about the verification."
                        disabled={form.formState.isSubmitting}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <SheetFooter className="mt-auto px-0 pb-0 pt-4 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={form.formState.isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting
                    ? "Saving..."
                    : "Acknowledge with times"}
                </Button>
              </SheetFooter>
            </form>
          </Form>
        </div>
      </SheetContent>
    </Sheet>
  );
}
