"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ClockIcon, UserXIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

const NO_SHOW_REASONS = [
  { value: "no_response", label: "Lead didn't show up (no communication)" },
  { value: "late_cancel", label: "Lead messaged — can't make it" },
  {
    value: "technical_issues",
    label: "Technical issues prevented meeting",
  },
  { value: "other", label: "Other reason" },
] as const;

const markNoShowSchema = z.object({
  reason: z.enum([
    "no_response",
    "late_cancel",
    "technical_issues",
    "other",
  ]),
  note: z.string().max(500, "Note must be under 500 characters").optional(),
});

type MarkNoShowValues = z.infer<typeof markNoShowSchema>;

type MarkNoShowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: Id<"meetings">;
  startedAt: number | undefined;
  onSuccess?: () => Promise<void>;
};

/** Format milliseconds as "X min Y sec" */
function formatWaitTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} sec`;
  return `${minutes} min ${seconds} sec`;
}

export function MarkNoShowDialog({
  open,
  onOpenChange,
  meetingId,
  startedAt,
  onSuccess,
}: MarkNoShowDialogProps) {
  const markNoShow = useMutation(api.closer.noShowActions.markNoShow);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Live-ticking wait time: updates every second while the dialog is open
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open || !startedAt) return;
    // Reset to current time when dialog opens
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [open, startedAt]);

  const waitMs = startedAt ? now - startedAt : undefined;

  // Do NOT pass an explicit generic to useForm — let the resolver infer types
  const form = useForm({
    resolver: standardSchemaResolver(markNoShowSchema),
    defaultValues: {
      reason: undefined as MarkNoShowValues["reason"] | undefined,
      note: "",
    },
  });

  // Reset form state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      form.reset();
    }
  }, [open, form]);

  const handleSubmit = async (values: MarkNoShowValues) => {
    setIsSubmitting(true);
    try {
      await markNoShow({
        meetingId,
        reason: values.reason,
        note: values.note || undefined, // Convert empty string to undefined
      });

      posthog.capture("meeting_marked_no_show", {
        meeting_id: meetingId,
        reason: values.reason,
        wait_duration_ms: waitMs,
      });

      toast.success("Meeting marked as no-show");
      await onSuccess?.();
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to mark no-show",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <UserXIcon className="size-5" />
            Mark as No-Show
          </AlertDialogTitle>
          <AlertDialogDescription>
            Record that the lead didn&rsquo;t show up for this meeting.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Wait time display — live-ticking when startedAt is available */}
        {waitMs !== undefined && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
            <ClockIcon className="size-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              You waited{" "}
              <span className="font-semibold text-foreground">
                {formatWaitTime(waitMs)}
              </span>
            </span>
          </div>
        )}

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-4"
          >
            {/* Reason — required Select */}
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Reason <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isSubmitting}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a reason..." />
                      </SelectTrigger>
                      <SelectContent>
                        {NO_SHOW_REASONS.map((r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Note — optional Textarea */}
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Any additional context..."
                      disabled={isSubmitting}
                      rows={3}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <AlertDialogFooter>
              <AlertDialogCancel disabled={isSubmitting}>
                Cancel
              </AlertDialogCancel>
              <Button
                type="submit"
                variant="destructive"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Marking...
                  </>
                ) : (
                  "Confirm No-Show"
                )}
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
