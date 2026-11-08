"use client";

import { useEffect, useId, useState } from "react";
import { useMutation } from "convex/react";
import { Controller, useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getErrorMessage } from "@/lib/errors";
import {
  ACTION_DIALOG,
  ACTION_FORM,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  FormRow,
  FormRows,
  SubmitButton,
  SubmitError,
} from "@/app/workspace/_components/action-dialog";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Sentinel for the "no default currency" option (Radix Select cannot use "").
const NONE_CURRENCY = "__none__";

const CURRENCY_OPTIONS = [
  { value: "USD", label: "USD \u2014 US Dollar" },
  { value: "EUR", label: "EUR \u2014 Euro" },
  { value: "GBP", label: "GBP \u2014 British Pound" },
  { value: "CAD", label: "CAD \u2014 Canadian Dollar" },
  { value: "AUD", label: "AUD \u2014 Australian Dollar" },
] as const;

// ---------------------------------------------------------------------------
// Zod schema — co-located per AGENTS.md § Form Patterns.
// ---------------------------------------------------------------------------

const programSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(80, "Name must be 80 characters or fewer"),
  description: z
    .string()
    .trim()
    .max(500, "Description must be 500 characters or fewer")
    .optional()
    .or(z.literal("")),
  defaultCurrency: z.string().optional(),
});

type ProgramFormValues = z.infer<typeof programSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ProgramFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  program?: {
    _id: Id<"tenantPrograms">;
    name: string;
    description?: string;
    defaultCurrency?: string;
  };
}

export function ProgramFormDialog({
  open,
  onOpenChange,
  program,
}: ProgramFormDialogProps) {
  const ids = useId();
  const isEdit = !!program;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const upsertProgram = useMutation(
    api.tenantPrograms.mutations.upsertProgram,
  );

  // Do NOT pass an explicit generic — let the resolver infer the types
  // (per AGENTS.md § Form Patterns).
  const form = useForm({
    resolver: standardSchemaResolver(programSchema),
    defaultValues: {
      name: program?.name ?? "",
      description: program?.description ?? "",
      defaultCurrency: program?.defaultCurrency ?? NONE_CURRENCY,
    },
  });

  // Clear any previous error each time the dialog opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSubmitError(null);
  }

  // Externally controlled dialog — reset form state whenever it re-opens so
  // the fields always match the currently-targeted program.
  useEffect(() => {
    if (open) {
      form.reset({
        name: program?.name ?? "",
        description: program?.description ?? "",
        defaultCurrency: program?.defaultCurrency ?? NONE_CURRENCY,
      });
    }
  }, [open, program, form]);

  const onSubmit = async (values: ProgramFormValues) => {
    setSubmitError(null);
    setIsSubmitting(true);

    // Normalize the sentinel back to undefined before the mutation call.
    const defaultCurrency =
      values.defaultCurrency && values.defaultCurrency !== NONE_CURRENCY
        ? values.defaultCurrency
        : undefined;
    const description =
      values.description && values.description.trim().length > 0
        ? values.description.trim()
        : undefined;

    try {
      const programId = await upsertProgram({
        programId: program?._id,
        name: values.name.trim(),
        description,
        defaultCurrency,
      });

      posthog.capture("program_saved", {
        action: isEdit ? "updated" : "created",
        programId,
      });

      toast.success(
        isEdit ? "Program updated" : "Program created",
      );
      onOpenChange(false);
    } catch (error) {
      const message =
        getErrorMessage(error, "Failed to save program");
      setSubmitError(message);
      reportClientError(error, { flow: "program_form_save" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        <ActionDialogHeader
          title={program ? `Edit ${program.name}` : "New program"}
          description={
            isEdit
              ? "A new name also shows on this program's past payments."
              : "Programs group customers and payments, and appear in every payment dialog."
          }
        />

        <form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM}>
          <SubmitError>{submitError}</SubmitError>
          <FormRows>
            <Controller
              control={form.control}
              name="name"
              render={({ field, fieldState }) => (
                <FormRow label="Name" htmlFor={`${ids}-name`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Input
                    {...field}
                    id={`${ids}-name`}
                    placeholder="e.g. Launchpad, Accelerator"
                    autoComplete="off"
                    aria-invalid={fieldState.invalid}
                    disabled={isSubmitting}
                  />
                </FormRow>
              )}
            />

            <Controller
              control={form.control}
              name="description"
              render={({ field, fieldState }) => (
                <FormRow
                  label="Description"
                  htmlFor={`${ids}-description`}
                  invalid={fieldState.invalid}
                  error={fieldState.error}
                  description="Optional. Only admins see it."
                >
                  <Textarea
                    {...field}
                    id={`${ids}-description`}
                    rows={3}
                    placeholder="Describe the program"
                    aria-invalid={fieldState.invalid}
                    disabled={isSubmitting}
                  />
                </FormRow>
              )}
            />

            <Controller
              control={form.control}
              name="defaultCurrency"
              render={({ field, fieldState }) => (
                <FormRow
                  label="Default currency"
                  htmlFor={`${ids}-currency`}
                  invalid={fieldState.invalid}
                  error={fieldState.error}
                  description="Pre-fills new payments and customer records. Leave as None to choose per payment."
                >
                  <Select
                    value={field.value ?? NONE_CURRENCY}
                    onValueChange={field.onChange}
                    disabled={isSubmitting}
                  >
                    <SelectTrigger id={`${ids}-currency`} aria-invalid={fieldState.invalid} className="w-full">
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_CURRENCY}>None</SelectItem>
                      {CURRENCY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormRow>
              )}
            />
          </FormRows>

          <ActionDialogFooter>
            <CancelButton onClick={() => onOpenChange(false)} disabled={isSubmitting} />
            <SubmitButton pending={isSubmitting} pendingLabel={isEdit ? "Saving…" : "Creating…"}>
              {isEdit ? "Save program" : "Create program"}
            </SubmitButton>
          </ActionDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
