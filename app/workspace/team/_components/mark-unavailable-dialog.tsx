"use client";

import { useState, useEffect, useCallback, useId } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { format } from "date-fns";
import { DayDefinition } from "@/app/workspace/_components/day-definition";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import {
  ACTION_DIALOG,
  ACTION_FORM,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  FIELD_ERROR,
  FormRow,
  FormRows,
  SubmitButton,
  SubmitError,
} from "@/app/workspace/_components/action-dialog";
import { getErrorMessage } from "@/lib/errors";
import { firstName } from "./team-ui";

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

/** Get start-of-day (browser midnight) timestamp for today. */
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
  /** Kept for callers; the title names the person. */
  userIdentity?: MemberAvatarIdentity;
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
  const ids = useId();
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

  const watchedIsFullDay = useWatch({ control: form.control, name: "isFullDay" });
  const watchedDate = useWatch({ control: form.control, name: "date" });

  // Clear any previous error each time the dialog opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSubmitError(null);
  }

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
          getErrorMessage(err, "Failed to mark closer as unavailable");
        setSubmitError(message);
      } finally {
        setIsSubmitting(false);
      }
    },
    [createUnavailability, userId, onOpenChange, router],
  );

  // Format today as "YYYY-MM-DD" for the date input default/min
  const todayString = format(new Date(), "yyyy-MM-dd");

  const first = firstName(userName);
  const { errors } = form.formState;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!isSubmitting) {
          onOpenChange(value);
        }
      }}
    >
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        <ActionDialogHeader
          title={`Mark ${userName} unavailable`}
          description={`If ${first} has calls booked in that time, you choose who takes each one next. Nothing moves until then.`}
        />

        <form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM}>
          <SubmitError>{submitError}</SubmitError>
          <FormRows>
            <Controller
              control={form.control}
              name="date"
              render={({ field, fieldState }) => (
                <FormRow label="Date" htmlFor={`${ids}-date`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Input
                    id={`${ids}-date`}
                    type="date"
                    min={todayString}
                    disabled={isSubmitting}
                    aria-invalid={fieldState.invalid}
                    className="w-fit font-condensed text-[15px] tabular-nums"
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
                  <DayDefinition browser />
                </FormRow>
              )}
            />

            <Controller
              control={form.control}
              name="isFullDay"
              render={({ field }) => (
                <FormRow label="Hours" invalid={Boolean(errors.startTime || errors.endTime)}>
                  <div className="flex min-h-8 items-center gap-2.5">
                    <Switch
                      id={`${ids}-full-day`}
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={isSubmitting}
                    />
                    <Label htmlFor={`${ids}-full-day`} className="font-normal">
                      All day
                    </Label>
                  </div>
                  {/* Start Time / End Time — shown only when not full day */}
                  {!watchedIsFullDay && (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <Controller
                          control={form.control}
                          name="startTime"
                          render={({ field: start, fieldState }) => (
                            <Input
                              type="time"
                              aria-label="Start time"
                              aria-invalid={fieldState.invalid}
                              disabled={isSubmitting}
                              className="w-32 font-condensed text-[15px] tabular-nums"
                              value={
                                start.value !== undefined
                                  ? timestampToTimeString(start.value, watchedDate)
                                  : ""
                              }
                              onChange={(e) => {
                                const val = e.target.value;
                                if (val) {
                                  start.onChange(timeStringToTimestamp(val, watchedDate));
                                } else {
                                  start.onChange(undefined);
                                }
                              }}
                            />
                          )}
                        />
                        <span className="text-[13px] text-muted-foreground">to</span>
                        <Controller
                          control={form.control}
                          name="endTime"
                          render={({ field: end, fieldState }) => (
                            <Input
                              type="time"
                              aria-label="End time"
                              aria-invalid={fieldState.invalid}
                              disabled={isSubmitting}
                              className="w-32 font-condensed text-[15px] tabular-nums"
                              value={
                                end.value !== undefined
                                  ? timestampToTimeString(end.value, watchedDate)
                                  : ""
                              }
                              onChange={(e) => {
                                const val = e.target.value;
                                if (val) {
                                  end.onChange(timeStringToTimestamp(val, watchedDate));
                                } else {
                                  end.onChange(undefined);
                                }
                              }}
                            />
                          )}
                        />
                      </div>
                      <FieldError className={FIELD_ERROR} errors={[errors.startTime, errors.endTime]} />
                    </>
                  )}
                </FormRow>
              )}
            />

            <Controller
              control={form.control}
              name="reason"
              render={({ field, fieldState }) => (
                <FormRow label="Reason" htmlFor={`${ids}-reason`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={isSubmitting}
                  >
                    <SelectTrigger id={`${ids}-reason`} aria-invalid={fieldState.invalid} className="w-full">
                      <SelectValue placeholder="Choose a reason" />
                    </SelectTrigger>
                    <SelectContent>
                      {REASON_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormRow>
              )}
            />

            <Controller
              control={form.control}
              name="note"
              render={({ field, fieldState }) => (
                <FormRow label="Note" htmlFor={`${ids}-note`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Textarea
                    {...field}
                    id={`${ids}-note`}
                    placeholder="Optional"
                    rows={2}
                    className="min-h-16 resize-none"
                    aria-invalid={fieldState.invalid}
                    disabled={isSubmitting}
                  />
                </FormRow>
              )}
            />
          </FormRows>

          <ActionDialogFooter>
            <CancelButton onClick={() => onOpenChange(false)} disabled={isSubmitting} />
            <SubmitButton pending={isSubmitting} pendingLabel="Saving…">
              Mark unavailable
            </SubmitButton>
          </ActionDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
