"use client";

import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircleIcon } from "lucide-react";
import { toast } from "sonner";

const eventTypeSchema = z.object({
  personalEventTypeUri: z
    .string()
    .min(1, "Event type URL is required")
    .url("Must be a valid URL")
    .refine(
      (url) => url.includes("calendly.com/"),
      "Must be a Calendly booking page URL (e.g., https://calendly.com/your-name/30min)"
    ),
});
type EventTypeFormValues = z.infer<typeof eventTypeSchema>;

type EventTypeAssignmentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: Id<"users">;
  userName: string;
  currentUri?: string;
};

export function EventTypeAssignmentDialog({
  open,
  onOpenChange,
  userId,
  userName,
  currentUri,
}: EventTypeAssignmentDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const assignEventType = useMutation(
    api.users.assignPersonalEventType.assignPersonalEventType
  );

  const form = useForm({
    resolver: standardSchemaResolver(eventTypeSchema),
    defaultValues: {
      personalEventTypeUri: currentUri ?? "",
    },
  });

  // Reset form when dialog opens with new data (externally controlled pattern)
  useEffect(() => {
    if (open) {
      form.reset({ personalEventTypeUri: currentUri ?? "" });
      setSubmitError(null);
    }
  }, [open, currentUri, form]);

  const onSubmit = async (values: EventTypeFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await assignEventType({
        userId,
        personalEventTypeUri: values.personalEventTypeUri,
      });
      toast.success(`Event type assigned to ${userName}`);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to assign event type."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {currentUri ? "Change" : "Assign"} Personal Event Type
          </DialogTitle>
          <DialogDescription>
            Enter the Calendly booking page URL for {userName}. This URL will be
            used to generate scheduling links for follow-ups.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
          >
            <FormField
              control={form.control}
              name="personalEventTypeUri"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Calendly Booking URL{" "}
                    <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="https://calendly.com/john-doe/30min"
                      disabled={isSubmitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {submitError && (
              <Alert variant="destructive">
                <AlertCircleIcon className="size-4" />
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting
                ? "Assigning..."
                : currentUri
                  ? "Update Event Type"
                  : "Assign Event Type"}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
