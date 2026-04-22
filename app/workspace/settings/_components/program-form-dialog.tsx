"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { toast } from "sonner";
import posthog from "posthog-js";
import { AlertCircleIcon } from "lucide-react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

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

  // Externally controlled dialog — reset form state whenever it re-opens so
  // the fields always match the currently-targeted program.
  useEffect(() => {
    if (open) {
      form.reset({
        name: program?.name ?? "",
        description: program?.description ?? "",
        defaultCurrency: program?.defaultCurrency ?? NONE_CURRENCY,
      });
      setSubmitError(null);
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
        error instanceof Error ? error.message : "Failed to save program";
      setSubmitError(message);
      posthog.captureException(error);
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Program" : "Create Program"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Renaming a program updates historical payments and customer records automatically."
              : "Programs group customers and payments for reporting. They appear in every payment dialog."}
          </DialogDescription>
        </DialogHeader>

        {submitError && (
          <Alert variant="destructive">
            <AlertCircleIcon className="size-4" />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-6"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Name <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Launchpad, Accelerator"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder="Describe the program"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Optional — visible in admin views only
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="defaultCurrency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Default Currency · Optional</FormLabel>
                  <Select
                    value={field.value ?? NONE_CURRENCY}
                    onValueChange={field.onChange}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE_CURRENCY}>None</SelectItem>
                      {CURRENCY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Pre-fills new payments and customer records. Leave blank to
                    decide per-payment.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Spinner data-icon="inline-start" />}
                {isSubmitting
                  ? isEdit
                    ? "Saving..."
                    : "Creating..."
                  : isEdit
                    ? "Save"
                    : "Create Program"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
