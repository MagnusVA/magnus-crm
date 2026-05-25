"use client";

import { useEffect, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { BanIcon } from "lucide-react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

const voidSubmissionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Enter a reason before voiding this submission.")
    .max(1000, "Reason must be 1000 characters or fewer."),
});

type VoidSubmissionFormValues = z.infer<typeof voidSubmissionSchema>;

export function VoidSubmissionDialog({
  submissionId,
  prospectLabel,
}: {
  submissionId: Id<"leadGenSubmissions">;
  prospectLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const voidSubmission = useMutation(api.leadGen.corrections.voidSubmission);
  const form = useForm({
    resolver: standardSchemaResolver(voidSubmissionSchema),
    defaultValues: { reason: "" },
    mode: "onChange",
  });
  const isSubmitting = form.formState.isSubmitting;
  const reason = useWatch({ control: form.control, name: "reason" }) ?? "";
  const trimmedReasonLength = reason.trim().length;
  const canSubmit =
    trimmedReasonLength >= 3 && trimmedReasonLength <= 1000 && !isSubmitting;

  useEffect(() => {
    if (!open) {
      form.reset({ reason: "" });
    }
  }, [form, open]);

  async function onSubmit(values: VoidSubmissionFormValues) {
    try {
      const result = await voidSubmission({
        submissionId,
        reason: values.reason,
      });
      toast.success(
        result.alreadyVoided
          ? "Submission was already voided"
          : "Submission voided",
      );
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to void submission",
      );
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (isSubmitting) return;
    setOpen(nextOpen);
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button
          aria-label={`Void submission${prospectLabel ? ` for ${prospectLabel}` : ""}`}
          size="sm"
          variant="destructive"
        >
          <BanIcon aria-hidden="true" data-icon="inline-start" />
          Void
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <BanIcon aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>Void submission?</AlertDialogTitle>
          <AlertDialogDescription>
            Voiding excludes this submission from reporting while keeping the
            raw record and audit trail. It does not delete the submission.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Form {...form}>
          <form
            className="flex flex-col gap-4"
            onSubmit={form.handleSubmit(onSubmit)}
          >
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason for voiding</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      autoComplete="off"
                      disabled={isSubmitting}
                      maxLength={1000}
                      placeholder="Explain why this submission should be voided…"
                      rows={4}
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
              <Button disabled={!canSubmit} type="submit" variant="destructive">
                {isSubmitting ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <BanIcon aria-hidden="true" data-icon="inline-start" />
                )}
                Void submission
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
