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
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { AlertCircleIcon, AlertTriangleIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLOSER_RESPONSE_OPTIONS = [
  {
    value: "forgot_to_press" as const,
    label: "I forgot to press start — I actually attended",
  },
  {
    value: "did_not_attend" as const,
    label: "I didn't attend this meeting",
  },
];

const STATED_OUTCOME_OPTIONS = [
  { value: "sale_made" as const, label: "Sale was made — payment needs to be logged" },
  { value: "follow_up_needed" as const, label: "Lead wants to think about it — needs follow-up" },
  { value: "lead_not_interested" as const, label: "Lead is not interested — deal is lost" },
  { value: "lead_no_show" as const, label: "Lead didn't show up" },
  { value: "other" as const, label: "Other" },
];

const DURATION_OPTIONS = [5, 10, 15, 20, 25, 30, 45, 60, 90, 120] as const;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const contextSchema = z
  .object({
    closerResponse: z.enum(["forgot_to_press", "did_not_attend"]),
    closerNote: z.string().min(1, "Please describe what happened"),
    closerStatedOutcome: z
      .enum(["sale_made", "follow_up_needed", "lead_not_interested", "lead_no_show", "other"])
      .optional(),
    estimatedMeetingDurationMinutes: z.coerce.number().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.closerResponse === "forgot_to_press") {
      if (!data.closerStatedOutcome) {
        ctx.addIssue({
          path: ["closerStatedOutcome"],
          code: "custom",
          message: "Outcome is required when you attended the meeting",
        });
      }
      if (
        !data.estimatedMeetingDurationMinutes ||
        data.estimatedMeetingDurationMinutes < 1
      ) {
        ctx.addIssue({
          path: ["estimatedMeetingDurationMinutes"],
          code: "custom",
          message: "Estimated duration is required",
        });
      }
    }
  });

type ContextFormValues = z.infer<typeof contextSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type MeetingOverranContextDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reviewId: Id<"meetingReviews">;
};

export function MeetingOverranContextDialog({
  open,
  onOpenChange,
  reviewId,
}: MeetingOverranContextDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);

  const respondToReview = useMutation(
    api.closer.meetingOverrun.respondToOverranReview,
  );

  const form = useForm({
    resolver: standardSchemaResolver(contextSchema),
    defaultValues: {
      closerResponse: undefined as unknown as "forgot_to_press" | "did_not_attend",
      closerNote: "",
      closerStatedOutcome: undefined,
      estimatedMeetingDurationMinutes: undefined,
    },
  });

  const watchedResponse = form.watch("closerResponse");

  const onSubmit = async (values: ContextFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await respondToReview({
        reviewId,
        closerResponse: values.closerResponse,
        closerNote: values.closerNote,
        closerStatedOutcome:
          values.closerResponse === "forgot_to_press"
            ? values.closerStatedOutcome
            : undefined,
        estimatedMeetingDurationMinutes:
          values.closerResponse === "forgot_to_press"
            ? values.estimatedMeetingDurationMinutes
            : undefined,
      });

      posthog.capture("meeting_overran_context_submitted", {
        review_id: reviewId,
        closer_response: values.closerResponse,
        closer_stated_outcome: values.closerStatedOutcome,
      });

      form.reset();
      onOpenChange(false);

      if (values.closerResponse === "forgot_to_press") {
        setShowConfirmation(true);
      } else {
        toast.success("Response recorded");
      }
    } catch (error) {
      posthog.captureException(error);
      setSubmitError(
        error instanceof Error ? error.message : "Failed to submit response",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!isSubmitting) {
            onOpenChange(value);
            if (!value) {
              form.reset();
              setSubmitError(null);
            }
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Provide Context</DialogTitle>
            <DialogDescription>
              This meeting was flagged because the system detected it ran past
              its scheduled end time without being started. Please let us know
              what happened.
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="closerResponse"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      What happened? <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <RadioGroup
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        {CLOSER_RESPONSE_OPTIONS.map((option) => (
                          <div
                            key={option.value}
                            className="flex items-center gap-2"
                          >
                            <RadioGroupItem
                              value={option.value}
                              id={`response-${option.value}`}
                              disabled={isSubmitting}
                            />
                            <Label
                              htmlFor={`response-${option.value}`}
                              className="cursor-pointer font-normal"
                            >
                              {option.label}
                            </Label>
                          </div>
                        ))}
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {watchedResponse === "forgot_to_press" && (
                <>
                  <FormField
                    control={form.control}
                    name="closerStatedOutcome"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Meeting outcome{" "}
                          <span className="text-destructive">*</span>
                        </FormLabel>
                        <Select
                          value={field.value ?? ""}
                          onValueChange={field.onChange}
                          disabled={isSubmitting}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select outcome" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {STATED_OUTCOME_OPTIONS.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="estimatedMeetingDurationMinutes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Estimated duration{" "}
                          <span className="text-destructive">*</span>
                        </FormLabel>
                        <Select
                          value={field.value ? String(field.value) : ""}
                          onValueChange={(val) => field.onChange(Number(val))}
                          disabled={isSubmitting}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select duration" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {DURATION_OPTIONS.map((minutes) => (
                              <SelectItem
                                key={minutes}
                                value={String(minutes)}
                              >
                                {minutes} minutes
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              <FormField
                control={form.control}
                name="closerNote"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Note <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder="Describe what happened..."
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
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      Submitting...
                    </>
                  ) : (
                    "Submit Response"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Confirmation alert after "forgot to press start" submission */}
      <AlertDialog open={showConfirmation} onOpenChange={setShowConfirmation}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
                <AlertTriangleIcon className="size-4 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="flex-1">
                <AlertDialogTitle>Response Recorded</AlertDialogTitle>
                <AlertDialogDescription>
                  Contact your supervisor. This meeting is flagged for admin
                  review. Your response has been saved and will be reviewed by
                  your team admin.
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction>Understood</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
