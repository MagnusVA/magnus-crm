"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { AlertCircleIcon, UserCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import type { Id } from "@/convex/_generated/dataModel";
import { format } from "date-fns";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const convertSchema = z.object({
  winningOpportunityId: z.string().min(1, "Select a winning opportunity"),
  notes: z.string().optional(),
});

type ConvertFormValues = z.infer<typeof convertSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ConvertToCustomerDialogProps {
  leadId: Id<"leads">;
  leadName: string;
  /** The lead's status — dialog is disabled for non-active leads */
  leadStatus: string;
  opportunities: Array<{
    _id: Id<"opportunities">;
    status: string;
    latestMeetingAt?: number | null;
    latestMeetingId?: Id<"meetings"> | null;
  }>;
}

/**
 * Manual lead-to-customer conversion dialog.
 *
 * Only shows opportunities with `payment_received` status in the dropdown.
 * If no eligible opportunities exist, the trigger button is disabled with
 * helper text explaining why.
 */
export function ConvertToCustomerDialog({
  leadId,
  leadName,
  leadStatus,
  opportunities,
}: ConvertToCustomerDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const convertMutation = useMutation(
    api.customers.mutations.convertLeadToCustomer,
  );

  // Only opportunities with payment_received are eligible
  const eligibleOpps = opportunities.filter(
    (o) => o.status === "payment_received",
  );

  const isDisabled =
    eligibleOpps.length === 0 || leadStatus !== "active";

  const form = useForm({
    resolver: standardSchemaResolver(convertSchema),
    defaultValues: {
      winningOpportunityId: eligibleOpps[0]?._id ?? "",
      notes: "",
    },
  });

  const onSubmit = async (values: ConvertFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const opp = eligibleOpps.find(
        (o) => o._id === values.winningOpportunityId,
      );

      const customerId = await convertMutation({
        leadId,
        winningOpportunityId:
          values.winningOpportunityId as Id<"opportunities">,
        winningMeetingId: (opp?.latestMeetingId as Id<"meetings">) ?? undefined,
        notes: values.notes || undefined,
      });

      toast.success(`${leadName} converted to customer`);
      setOpen(false);
      form.reset();

      // Navigate to the new customer detail page
      if (customerId) {
        router.push(`/workspace/customers/${customerId}`);
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Conversion failed";
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
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
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={isDisabled}>
          <UserCheckIcon className="mr-1.5 h-3.5 w-3.5" />
          Convert to Customer
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Convert {leadName} to Customer</DialogTitle>
          <DialogDescription>
            This will create a customer record and mark the lead as converted.
            Select the winning opportunity (must have a recorded payment).
          </DialogDescription>
        </DialogHeader>

        {eligibleOpps.length === 0 ? (
          <div className="py-4">
            <Alert>
              <AlertCircleIcon />
              <AlertDescription>
                No eligible opportunities. Record a payment on an opportunity
                first to enable conversion.
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="winningOpportunityId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Winning Opportunity{" "}
                      <span className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select opportunity" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {eligibleOpps.map((opp) => (
                          <SelectItem key={opp._id} value={opp._id}>
                            Opportunity —{" "}
                            {opp.latestMeetingAt
                              ? format(
                                  new Date(opp.latestMeetingAt),
                                  "MMM d, yyyy",
                                )
                              : "No meeting date"}
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
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes (optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder="Conversion notes..."
                        disabled={isSubmitting}
                      />
                    </FormControl>
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
                  variant="ghost"
                  onClick={() => {
                    setOpen(false);
                    form.reset();
                    setSubmitError(null);
                  }}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      Converting...
                    </>
                  ) : (
                    "Convert to Customer"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
