"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { AlertCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REASON_OPTIONS = [
  { value: "sick", label: "Sick" },
  { value: "emergency", label: "Emergency" },
  { value: "personal", label: "Personal" },
  { value: "other", label: "Other" },
] as const;

// ---------------------------------------------------------------------------
// Helpers — time string ↔ timestamp conversion
// ---------------------------------------------------------------------------

/** Convert "HH:mm" + a date timestamp (start of day) into an absolute timestamp. */
function timeStringToTimestamp(time: string, dateTimestamp: number): number {
  const [hours, minutes] = time.split(":").map(Number);
  return dateTimestamp + hours * 60 * 60 * 1000 + minutes * 60 * 1000;
}

/** Convert an absolute timestamp into "HH:mm" relative to a date timestamp. */
function timestampToTimeString(
  timestamp: number,
  dateTimestamp: number,
): string {
  const offsetMs = timestamp - dateTimestamp;
  const totalMinutes = Math.floor(offsetMs / (60 * 1000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Get start-of-day (midnight UTC) timestamp for today. */
function getTodayTimestamp(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Convert a "YYYY-MM-DD" date string to a start-of-day timestamp. */
function dateStringToTimestamp(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}

// ---------------------------------------------------------------------------
// Zod schema — cross-field validation via .superRefine()
// ---------------------------------------------------------------------------

const markUnavailableSchema = z
  .object({
    date: z.number({ error: "Date is required" }),
    reason: z.enum(["sick", "emergency", "personal", "other"], {
      error: "Reason is required",
    }),
    note: z.string().max(500, "Note must be under 500 characters").optional(),
    isFullDay: z.boolean(),
    startTime: z.number().optional(),
    endTime: z.number().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.isFullDay) {
      if (data.startTime === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "Start time is required for partial-day unavailability",
          path: ["startTime"],
        });
      }
      if (data.endTime === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "End time is required for partial-day unavailability",
          path: ["endTime"],
        });
      }
      if (
        data.startTime !== undefined &&
        data.endTime !== undefined &&
        data.startTime >= data.endTime
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Start time must be before end time",
          path: ["endTime"],
        });
      }
    }
  });

type MarkUnavailableFormValues = z.infer<typeof markUnavailableSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface MarkUnavailableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: Id<"users">;
  userName: string;
}

/**
 * Mark Unavailable Dialog — allows admins to mark a closer as unavailable
 * for a specific date (full day or partial).
 *
 * - Date, reason (enum), optional note, full-day toggle
 * - When partial day: start time + end time fields appear
 * - On submit: calls createCloserUnavailability mutation
 * - If affected meetings exist: navigates to redistribution page
 * - If no affected meetings: closes dialog with success toast
 */
export function MarkUnavailableDialog({
  open,
  onOpenChange,
  userId,
  userName,
}: MarkUnavailableDialogProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const createUnavailability = useMutation(
    api.unavailability.mutations.createCloserUnavailability,
  );

  const todayTimestamp = getTodayTimestamp();

  const form = useForm({
    resolver: standardSchemaResolver(markUnavailableSchema),
    defaultValues: {
      date: todayTimestamp,
      reason: undefined as MarkUnavailableFormValues["reason"] | undefined,
      note: "",
      isFullDay: true,
      startTime: undefined as number | undefined,
      endTime: undefined as number | undefined,
    },
  });

  const watchedIsFullDay = form.watch("isFullDay");
  const watchedDate = form.watch("date");

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      form.reset({
        date: getTodayTimestamp(),
        reason: undefined,
        note: "",
        isFullDay: true,
        startTime: undefined,
        endTime: undefined,
      });
      setSubmitError(null);
    }
  }, [open, form]);

  // Clear time fields when switching to full day
  useEffect(() => {
    if (watchedIsFullDay) {
      form.setValue("startTime", undefined);
      form.setValue("endTime", undefined);
      form.clearErrors("startTime");
      form.clearErrors("endTime");
    }
  }, [watchedIsFullDay, form]);

  const onSubmit = useCallback(
    async (values: MarkUnavailableFormValues) => {
      setIsSubmitting(true);
      setSubmitError(null);

      try {
        const result = await createUnavailability({
          closerId: userId,
          date: values.date,
          reason: values.reason,
          note: values.note || undefined,
          isFullDay: values.isFullDay,
          startTime: values.isFullDay ? undefined : values.startTime,
          endTime: values.isFullDay ? undefined : values.endTime,
        });

        if (result.affectedMeetings.length > 0) {
          onOpenChange(false);
          router.push(
            `/workspace/team/redistribute/${result.unavailabilityId}`,
          );
        } else {
          toast.success(
            "Closer marked as unavailable. No meetings need redistribution.",
          );
          onOpenChange(false);
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to mark closer as unavailable";
        setSubmitError(message);
      } finally {
        setIsSubmitting(false);
      }
    },
    [createUnavailability, userId, onOpenChange, router],
  );

  // Format today as "YYYY-MM-DD" for the date input default/min
  const todayString = format(new Date(), "yyyy-MM-dd");

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!isSubmitting) {
          onOpenChange(value);
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark as Unavailable</DialogTitle>
          <DialogDescription>
            Mark {userName} as unavailable. Any affected meetings will be flagged
            for redistribution.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup>
              {/* Date */}
              <FormField
                control={form.control}
                name="date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Date <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        min={todayString}
                        disabled={isSubmitting}
                        value={
                          field.value
                            ? format(new Date(field.value), "yyyy-MM-dd")
                            : ""
                        }
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val) {
                            field.onChange(dateStringToTimestamp(val));
                          }
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Reason */}
              <FormField
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Reason <span className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a reason" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {REASON_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Note (optional) */}
              <FormField
                control={form.control}
                name="note"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Note</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Additional details (optional)"
                        className="min-h-[80px] resize-none text-sm"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Full Day Toggle */}
              <FormField
                control={form.control}
                name="isFullDay"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-2">
                    <FormLabel className="mt-0">Full Day</FormLabel>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={isSubmitting}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              {/* Start Time / End Time — shown only when not full day */}
              {!watchedIsFullDay && (
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="startTime"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Start Time{" "}
                          <span className="text-destructive">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="time"
                            disabled={isSubmitting}
                            value={
                              field.value !== undefined
                                ? timestampToTimeString(
                                    field.value,
                                    watchedDate,
                                  )
                                : ""
                            }
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val) {
                                field.onChange(
                                  timeStringToTimestamp(val, watchedDate),
                                );
                              } else {
                                field.onChange(undefined);
                              }
                            }}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="endTime"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          End Time{" "}
                          <span className="text-destructive">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="time"
                            disabled={isSubmitting}
                            value={
                              field.value !== undefined
                                ? timestampToTimeString(
                                    field.value,
                                    watchedDate,
                                  )
                                : ""
                            }
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val) {
                                field.onChange(
                                  timeStringToTimestamp(val, watchedDate),
                                );
                              } else {
                                field.onChange(undefined);
                              }
                            }}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              )}
            </FieldGroup>

            {/* Submission-level error (mutation failures) */}
            {submitError && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircleIcon />
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}

            <DialogFooter className="mt-5">
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
                    Saving...
                  </>
                ) : (
                  "Mark Unavailable"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
