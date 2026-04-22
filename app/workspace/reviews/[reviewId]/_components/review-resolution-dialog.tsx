"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation, useQuery } from "convex/react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { ProgramSelect } from "@/app/workspace/closer/_components/program-select";

type ResolutionAction =
  | "log_payment"
  | "schedule_follow_up"
  | "mark_no_show"
  | "mark_lost"
  | "acknowledged"
  | "disputed";

const ACTION_CONFIG = {
  log_payment: {
    title: "Log Payment",
    description:
      "Record a payment for this opportunity. If the closer claimed they attended, the meeting will be corrected to 'completed'.",
    confirmLabel: "Log Payment & Resolve",
  },
  schedule_follow_up: {
    title: "Schedule Follow-Up",
    description:
      "Create a follow-up for this lead and resolve the review. The opportunity will remain in 'meeting overran' — follow-ups do NOT transition terminal overran opportunities.",
    confirmLabel: "Create Follow-Up & Resolve",
  },
  mark_no_show: {
    title: "Mark as No-Show",
    description: "Mark the lead as a no-show for this meeting.",
    confirmLabel: "Mark No-Show & Resolve",
  },
  mark_lost: {
    title: "Mark as Lost",
    description: "Mark this deal as lost.",
    confirmLabel: "Mark Lost & Resolve",
  },
  acknowledged: {
    title: "Acknowledge Review",
    description:
      "Acknowledge this review without changing the opportunity or meeting status. Use when the closer has already handled the situation correctly.",
    confirmLabel: "Acknowledge & Resolve",
  },
  disputed: {
    title: "Dispute Review",
    description:
      "Dispute this review. The opportunity and meeting will revert to 'meeting overran' as the final outcome. " +
      "Any closer actions will be neutralized: disputed payments are marked invalid (reversing revenue + customer conversion if applicable), " +
      "pending follow-ups are expired, no-show and lost outcomes are reversed. Audit history is preserved.",
    confirmLabel: "Dispute & Finalize",
  },
} satisfies Record<
  ResolutionAction,
  { title: string; description: string; confirmLabel: string }
>;

const NO_SHOW_REASONS = [
  { value: "no_response", label: "Lead didn't show up" },
  { value: "late_cancel", label: "Lead messaged -- couldn't make it" },
  { value: "technical_issues", label: "Technical issues" },
  { value: "other", label: "Other" },
] as const;

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;
const PAYMENT_TYPES = ["monthly", "split", "pif", "deposit"] as const;
const PAYMENT_TYPE_LABELS: Record<(typeof PAYMENT_TYPES)[number], string> = {
  monthly: "Monthly",
  split: "Split",
  pif: "Paid in Full",
  deposit: "Deposit",
};

function buildSchema(action: ResolutionAction) {
  const base = z.object({
    amount: z.string().optional(),
    currency: z.string().optional(),
    programId: z.string().optional(),
    paymentType: z.string().optional(),
    referenceCode: z.string().optional(),
    noShowReason: z.string().optional(),
    lostReason: z.string().optional(),
    resolutionNote: z.string().optional(),
  });

  return base.superRefine((data, ctx) => {
    if (action === "log_payment") {
      if (!data.amount || data.amount.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "Amount is required",
          path: ["amount"],
        });
      } else {
        const parsed = parseFloat(data.amount);
        if (isNaN(parsed) || parsed < 0.01) {
          ctx.addIssue({
            code: "custom",
            message: "Amount must be greater than 0",
            path: ["amount"],
          });
        }
      }

      if (!data.currency || data.currency.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "Currency is required",
          path: ["currency"],
        });
      }

      if (!data.programId || data.programId.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "Program is required",
          path: ["programId"],
        });
      }

      if (
        !data.paymentType ||
        !PAYMENT_TYPES.includes(data.paymentType as (typeof PAYMENT_TYPES)[number])
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Payment type is required",
          path: ["paymentType"],
        });
      }
    }

    if (action === "schedule_follow_up") {
      if (!data.resolutionNote || data.resolutionNote.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "A note about the follow-up plan is required",
          path: ["resolutionNote"],
        });
      }
    }

    if (action === "mark_no_show" && !data.noShowReason) {
      ctx.addIssue({
        code: "custom",
        message: "Reason is required",
        path: ["noShowReason"],
      });
    }
  });
}

type ResolutionFormValues = z.infer<ReturnType<typeof buildSchema>>;

const DEFAULT_VALUES: ResolutionFormValues = {
  amount: "",
  currency: "USD",
  programId: "",
  paymentType: "",
  referenceCode: "",
  noShowReason: "",
  lostReason: "",
  resolutionNote: "",
};

type ReviewResolutionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reviewId: Id<"meetingReviews">;
  resolutionAction: ResolutionAction;
  closerResponse?: string;
};

export function ReviewResolutionDialog({
  open,
  onOpenChange,
  reviewId,
  resolutionAction,
  closerResponse,
}: ReviewResolutionDialogProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
    includeArchived: false,
  });
  const resolveReview = useMutation(api.reviews.mutations.resolveReview);

  const config = ACTION_CONFIG[resolutionAction];
  const schema = useMemo(() => buildSchema(resolutionAction), [resolutionAction]);

  const form = useForm<ResolutionFormValues>({
    resolver: standardSchemaResolver(schema),
    defaultValues: DEFAULT_VALUES,
  });

  const isProgramListLoading = programs === undefined;
  const hasPrograms = (programs?.length ?? 0) > 0;
  const isLogPaymentBlocked =
    resolutionAction === "log_payment" && (isProgramListLoading || !hasPrograms);

  const handleSubmit = async (data: ResolutionFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      if (
        resolutionAction === "log_payment" &&
        (!programs || programs.length === 0)
      ) {
        throw new Error("Create an active program before logging a payment.");
      }

      const resolutionNote = data.resolutionNote?.trim() || undefined;

      await resolveReview({
        reviewId,
        resolutionAction,
        resolutionNote,
        ...(resolutionAction === "log_payment" && {
          paymentData: {
            amount: parseFloat(data.amount ?? "0"),
            currency: data.currency as string,
            programId: data.programId as Id<"tenantPrograms">,
            paymentType: data.paymentType as
              | "monthly"
              | "split"
              | "pif"
              | "deposit",
            referenceCode: data.referenceCode?.trim() || undefined,
          },
        }),
        ...(resolutionAction === "mark_lost" && {
          lostReason: data.lostReason?.trim() || undefined,
        }),
        ...(resolutionAction === "mark_no_show" && {
          noShowReason: data.noShowReason as
            | "no_response"
            | "late_cancel"
            | "technical_issues"
            | "other",
        }),
      });

      toast.success("Review resolved");
      onOpenChange(false);
      router.push("/workspace/reviews");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to resolve review";
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
          <DialogTitle>{config.title}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-4"
          >
            {submitError && (
              <Alert variant="destructive">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}

            {closerResponse === "forgot_to_press" &&
              resolutionAction !== "acknowledged" && (
                <Alert>
                  <AlertDescription>
                    The closer claimed they attended but forgot to press start.
                    Resolving will correct the meeting status to
                    &ldquo;completed&rdquo;.
                  </AlertDescription>
                </Alert>
              )}

            {resolutionAction === "log_payment" && (
              <>
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Amount <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value ?? ""}
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="299.99"
                          disabled={isSubmitting}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="currency"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Currency <span className="text-destructive">*</span>
                        </FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value ?? "USD"}
                          disabled={isSubmitting}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {CURRENCIES.map((curr) => (
                              <SelectItem key={curr} value={curr}>
                                {curr}
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
                    name="paymentType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Payment Type{" "}
                          <span className="text-destructive">*</span>
                        </FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value || undefined}
                          disabled={isSubmitting}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select..." />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {PAYMENT_TYPES.map((paymentType) => (
                              <SelectItem key={paymentType} value={paymentType}>
                                {PAYMENT_TYPE_LABELS[paymentType]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="programId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Program <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <ProgramSelect
                          value={field.value || undefined}
                          onChange={field.onChange}
                          disabled={isSubmitting || isLogPaymentBlocked}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="referenceCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reference Code</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value ?? ""}
                          placeholder="Optional transaction ID"
                          disabled={isSubmitting}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                {!isProgramListLoading && !hasPrograms && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      No active programs are available. Create one before
                      logging a payment from review resolution.
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}

            {resolutionAction === "mark_no_show" && (
              <FormField
                control={form.control}
                name="noShowReason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Reason <span className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value ?? ""}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select reason..." />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {NO_SHOW_REASONS.map((reason) => (
                          <SelectItem key={reason.value} value={reason.value}>
                            {reason.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {resolutionAction === "mark_lost" && (
              <FormField
                control={form.control}
                name="lostReason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reason</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        placeholder="Optional reason for marking as lost"
                        disabled={isSubmitting}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="resolutionNote"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Admin Note
                    {resolutionAction === "schedule_follow_up" && (
                      <span className="text-destructive"> *</span>
                    )}
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      value={field.value ?? ""}
                      placeholder={
                        resolutionAction === "schedule_follow_up"
                          ? "What was agreed? What should the follow-up cover?"
                          : "Optional note about this resolution..."
                      }
                      rows={2}
                      disabled={isSubmitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onOpenChange(false);
                  form.reset();
                  setSubmitError(null);
                }}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting || isLogPaymentBlocked}
                variant={
                  resolutionAction === "mark_lost" ||
                  resolutionAction === "disputed"
                    ? "destructive"
                    : "default"
                }
              >
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Resolving...
                  </>
                ) : (
                  config.confirmLabel
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
