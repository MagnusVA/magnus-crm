"use client";

import { useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { AlertTriangleIcon } from "lucide-react";
import posthog from "posthog-js";
import { reportClientError } from "@/lib/observability/report-client-error";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FieldGroup } from "@/components/ui/field";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
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
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getErrorMessage } from "@/lib/errors";

const voidPaymentSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Reason is required")
    .max(500, "Reason must be under 500 characters"),
});

type VoidPaymentValues = z.infer<typeof voidPaymentSchema>;

export function VoidPaymentDialog({
  paymentId,
}: {
  paymentId: Id<"paymentRecords">;
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const voidPayment = useMutation(api.sideDeals.voidPayment.voidPayment);

  const form = useForm({
    resolver: standardSchemaResolver(voidPaymentSchema),
    defaultValues: { reason: "" },
  });

  const onSubmit = async (values: VoidPaymentValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      await voidPayment({ paymentId, reason: values.reason.trim() });
      posthog.capture("side_deal_payment_voided", {
        payment_id: paymentId,
      });
      toast.success("Payment voided");
      form.reset();
      setOpen(false);
    } catch (error) {
      reportClientError(error, { flow: "payment_void" });
      const message =
        getErrorMessage(error, "Couldn't void the payment");
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog
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
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="text-danger-ink hover:text-danger-ink"
          aria-label="Void this payment"
        >
          Void
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
              <AlertTriangleIcon className="size-4 text-danger-ink" aria-hidden="true" />
            </div>
            <div className="flex-1">
              <AlertDialogTitle>Void this side-deal payment?</AlertDialogTitle>
              <AlertDialogDescription>
                The payment is marked disputed, its revenue comes off the
                reports, and the side deal closes as lost.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      className="resize-none"
                      placeholder="Duplicate entry from yesterday…"
                      autoComplete="off"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            </FieldGroup>

            {submitError ? (
              <Alert variant="destructive" className="mt-4">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <AlertDialogFooter className="mt-4">
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
                    Voiding…
                  </>
                ) : (
                  "Void payment"
                )}
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
