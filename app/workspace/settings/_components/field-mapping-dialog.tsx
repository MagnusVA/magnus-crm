"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import posthog from "posthog-js";

// Sentinel value for "no selection" in Select components
// (Radix Select doesn't support empty string as a value)
const NONE_VALUE = "__none__";

// Co-located Zod schema — per Feature J form pattern
const fieldMappingSchema = z
  .object({
    socialHandleField: z.string(),
    socialHandleType: z.string(),
    phoneField: z.string(),
  })
  .superRefine((data, ctx) => {
    // If social handle field is selected, require a platform type
    if (
      data.socialHandleField &&
      data.socialHandleField !== NONE_VALUE &&
      (!data.socialHandleType || data.socialHandleType === NONE_VALUE)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Select a platform when a social handle field is mapped.",
        path: ["socialHandleType"],
      });
    }
    // Prevent double-mapping the same question
    if (
      data.socialHandleField &&
      data.socialHandleField !== NONE_VALUE &&
      data.phoneField &&
      data.phoneField !== NONE_VALUE &&
      data.socialHandleField === data.phoneField
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Cannot use the same field for both social handle and phone.",
        path: ["phoneField"],
      });
    }
  });

type FieldMappingFormValues = z.infer<typeof fieldMappingSchema>;

interface CustomFieldMappings {
  socialHandleField?: string;
  socialHandleType?: "instagram" | "tiktok" | "twitter" | "other_social";
  phoneField?: string;
}

interface EventTypeConfigWithStats {
  _id: string;
  displayName: string;
  customFieldMappings?: CustomFieldMappings;
  knownCustomFieldKeys?: string[];
  fieldCount: number;
}

interface FieldMappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: EventTypeConfigWithStats;
  onSuccess?: () => void;
}

const SOCIAL_PLATFORMS = [
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "twitter", label: "X (Twitter)" },
  { value: "other_social", label: "Other" },
] as const;

export function FieldMappingDialog({
  open,
  onOpenChange,
  config,
  onSuccess,
}: FieldMappingDialogProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const updateMappings = useMutation(
    api.eventTypeConfigs.mutations.updateCustomFieldMappings,
  );

  // Do NOT pass explicit generic — let the resolver infer types (per AGENTS.md)
  const form = useForm({
    resolver: standardSchemaResolver(fieldMappingSchema),
    defaultValues: {
      socialHandleField:
        config.customFieldMappings?.socialHandleField ?? NONE_VALUE,
      socialHandleType:
        config.customFieldMappings?.socialHandleType ?? NONE_VALUE,
      phoneField: config.customFieldMappings?.phoneField ?? NONE_VALUE,
    },
  });

  // Reset form when dialog opens with different config
  // (externally controlled dialog pattern — same as role-edit-dialog.tsx)
  useEffect(() => {
    if (open) {
      form.reset({
        socialHandleField:
          config.customFieldMappings?.socialHandleField ?? NONE_VALUE,
        socialHandleType:
          config.customFieldMappings?.socialHandleType ?? NONE_VALUE,
        phoneField: config.customFieldMappings?.phoneField ?? NONE_VALUE,
      });
      setSubmitError(null);
    }
  }, [open, config, form]);

  const knownKeys = config.knownCustomFieldKeys ?? [];

  const onSubmit = async (values: FieldMappingFormValues) => {
    setSubmitError(null);

    // Convert NONE_VALUE sentinel back to undefined for the mutation
    const mappings = {
      socialHandleField:
        values.socialHandleField !== NONE_VALUE
          ? values.socialHandleField
          : undefined,
      socialHandleType:
        values.socialHandleType !== NONE_VALUE
          ? (values.socialHandleType as
              | "instagram"
              | "tiktok"
              | "twitter"
              | "other_social")
          : undefined,
      phoneField:
        values.phoneField !== NONE_VALUE ? values.phoneField : undefined,
    };

    try {
      await updateMappings({
        eventTypeConfigId: config._id as Id<"eventTypeConfigs">,
        customFieldMappings: mappings,
      });

      posthog.capture("field_mapping_saved", {
        event_type_config_id: config._id,
        has_social_handle: !!mappings.socialHandleField,
        social_platform: mappings.socialHandleType ?? null,
        has_phone_override: !!mappings.phoneField,
      });

      toast.success("Field mappings saved");
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to save field mappings";
      setSubmitError(message);
      posthog.captureException(error);
    }
  };

  const isSubmitting = form.formState.isSubmitting;
  const watchSocialField = form.watch("socialHandleField");
  const isSocialFieldSelected =
    watchSocialField && watchSocialField !== NONE_VALUE;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Configure Field Mappings</DialogTitle>
          <DialogDescription>
            Map Calendly form questions to CRM identity fields for{" "}
            <strong>{config.displayName}</strong>. Dropdowns show actual form
            field names discovered from bookings.
          </DialogDescription>
        </DialogHeader>

        {submitError && (
          <Alert variant="destructive">
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
              name="socialHandleField"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Social Handle Field</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a form field..." />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>(none)</SelectItem>
                      {knownKeys.map((key) => (
                        <SelectItem key={key} value={key}>
                          {key}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Which form question asks for the lead&apos;s social media
                    handle?
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="socialHandleType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Social Platform</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={isSubmitting || !isSocialFieldSelected}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select platform..." />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>(none)</SelectItem>
                      {SOCIAL_PLATFORMS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Which social media platform does this handle belong to?
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="phoneField"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone Field (Override)</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a form field..." />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>(none)</SelectItem>
                      {knownKeys.map((key) => (
                        <SelectItem key={key} value={key}>
                          {key}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Override if the lead&apos;s phone number is captured in a
                    custom form field instead of Calendly&apos;s built-in phone
                    field.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Spinner className="mr-2 size-4" />}
                {isSubmitting ? "Saving..." : "Save Mappings"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
