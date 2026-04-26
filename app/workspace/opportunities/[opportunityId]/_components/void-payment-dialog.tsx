"use client";

import { useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { AlertTriangleIcon } from "lucide-react";
import posthog from "posthog-js";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

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
      posthog.captureException(error);
      const message =
        error instanceof Error ? error.message : "Failed to void payment";
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
        <Button variant="destructive" size="sm">
          Void payment
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <AlertTriangleIcon aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>Void this side-deal payment?</AlertDialogTitle>
          <AlertDialogDescription>
            This marks the payment as disputed, reverses side-deal revenue, and
            moves the opportunity to lost.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Reason <span className="text-destructive">*</span>
                  </FormLabel>
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

            {submitError ? (
              <Alert variant="destructive" className="mt-4">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <AlertDialogFooter className="mt-5">
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
