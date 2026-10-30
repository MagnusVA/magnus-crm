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
import { UserXIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { getErrorMessage } from "@/lib/errors";

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
  mode?: "closer" | "admin";
  onSuccess?: () => Promise<void>;
  /** Named in the dialog so the closer knows whose call this records. */
  leadName?: string | null;
};

export function MarkNoShowDialog({
  open,
  onOpenChange,
  meetingId,
  mode = "closer",
  onSuccess,
  leadName,
}: MarkNoShowDialogProps) {
  const closerMarkNoShow = useMutation(api.closer.noShowActions.markNoShow);
  const adminMarkNoShow = useMutation(api.admin.meetingActions.adminMarkNoShow);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
      const markNoShow =
        mode === "admin" ? adminMarkNoShow : closerMarkNoShow;
      await markNoShow({
        meetingId,
        reason: values.reason,
        note: values.note || undefined, // Convert empty string to undefined
      });

      posthog.capture("meeting_marked_no_show", {
        meeting_id: meetingId,
        reason: values.reason,
        source: mode,
      });

      toast.success("No-show recorded. The deal is closed as lost.");
      await onSuccess?.();
      onOpenChange(false);
    } catch (error) {
      toast.error(
        getErrorMessage(error, "Failed to mark no-show"),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        // Esc mid-submit would reset the form under the running mutation.
        if (!isSubmitting) onOpenChange(value);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <UserXIcon className="size-5" />
            {leadName ? `${leadName} didn\u2019t show up` : "Record a no-show"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            The call is marked no-show and the deal closes as lost, with the
            reason you pick.{" "}
            {mode === "admin"
              ? "You can then send a reschedule link from this page."
              : "You can then send a reschedule link."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="flex flex-col gap-4"
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
                        <SelectValue placeholder="Select a reason…" />
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
                      placeholder="Any additional context…"
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
                className="text-danger-ink"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Marking…
                  </>
                ) : (
                  "Record no-show"
                )}
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
