"use client";

import { useEffect, useState } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { PaymentLinkEditor } from "./payment-link-editor";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import posthog from "posthog-js";

// Sentinel value for "no selection" in Select components
// (Radix Select doesn't support empty string as a value)
const NONE_VALUE = "__none__";

const eventTypeConfigSchema = z
  .object({
    displayName: z.string().min(1, "Display name is required"),
    bookingProgramId: z.string(),
    bookingBaseUrl: z.string(),
    isExtended: z.boolean(),
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

type EventTypeConfigFormValues = z.infer<typeof eventTypeConfigSchema>;

const SOCIAL_PLATFORMS = [
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "twitter", label: "X (Twitter)" },
  { value: "other_social", label: "Other" },
] as const;

interface PaymentLink {
  provider: string;
  label: string;
  url: string;
}

interface CustomFieldMappings {
  socialHandleField?: string;
  socialHandleType?: "instagram" | "tiktok" | "twitter" | "other_social";
  phoneField?: string;
}

interface EventTypeConfig {
  _id?: string;
  calendlyEventTypeUri: string;
  displayName: string;
  paymentLinks?: PaymentLink[];
  bookingProgramId?: Id<"tenantPrograms">;
  bookingBaseUrl?: string;
  isExtended?: boolean;
  customFieldMappings?: CustomFieldMappings;
  knownCustomFieldKeys?: string[];
  fieldCount?: number;
  bookingCount?: number;
}

interface EventTypeConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: EventTypeConfig;
  onSuccess?: () => void;
}

function defaultsFromConfig(config: EventTypeConfig): EventTypeConfigFormValues {
  return {
    displayName: config.displayName,
    bookingProgramId: config.bookingProgramId ?? NONE_VALUE,
    bookingBaseUrl: config.bookingBaseUrl ?? "",
    isExtended: config.isExtended === true,
    socialHandleField:
      config.customFieldMappings?.socialHandleField ?? NONE_VALUE,
    socialHandleType:
      config.customFieldMappings?.socialHandleType ?? NONE_VALUE,
    phoneField: config.customFieldMappings?.phoneField ?? NONE_VALUE,
  };
}

export function EventTypeConfigDialog({
  open,
  onOpenChange,
  config,
  onSuccess,
}: EventTypeConfigDialogProps) {
  const [paymentLinks, setPaymentLinks] = useState<PaymentLink[]>(
    config.paymentLinks || [],
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
    includeArchived: false,
  });

  const upsertConfig = useMutation(
    api.eventTypeConfigs.mutations.upsertEventTypeConfig,
  );
  const updateMappings = useMutation(
    api.eventTypeConfigs.mutations.updateCustomFieldMappings,
  );

  const form = useForm({
    resolver: standardSchemaResolver(eventTypeConfigSchema),
    defaultValues: defaultsFromConfig(config),
  });

  useEffect(() => {
    if (open) {
      form.reset(defaultsFromConfig(config));
      setPaymentLinks(config.paymentLinks || []);
      setSubmitError(null);
    }
  }, [config, form, open]);

  const knownKeys = config.knownCustomFieldKeys ?? [];
  const fieldCount = config.fieldCount ?? knownKeys.length;
  const mappingsAvailable = Boolean(config._id) && fieldCount > 0;

  const onSubmit = async (values: EventTypeConfigFormValues) => {
    setSubmitError(null);

    try {
      await upsertConfig({
        calendlyEventTypeUri: config.calendlyEventTypeUri,
        displayName: values.displayName,
        paymentLinks: paymentLinks.length > 0 ? paymentLinks : undefined,
        bookingProgramId:
          values.bookingProgramId !== NONE_VALUE
            ? (values.bookingProgramId as Id<"tenantPrograms">)
            : undefined,
        bookingBaseUrl: values.bookingBaseUrl.trim() || undefined,
        isExtended: values.isExtended,
      });

      posthog.capture("event_type_config_saved", {
        calendly_event_type_uri: config.calendlyEventTypeUri,
        payment_link_count: paymentLinks.length,
      });
    } catch (error) {
      posthog.captureException(error);
      setSubmitError(
        error instanceof Error ? error.message : "Failed to save configuration",
      );
      return;
    }

    const { dirtyFields } = form.formState;
    const mappingsDirty =
      dirtyFields.socialHandleField ||
      dirtyFields.socialHandleType ||
      dirtyFields.phoneField;

    if (config._id && mappingsDirty) {
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
      } catch (error) {
        posthog.captureException(error);
        setSubmitError(
          error instanceof Error
            ? `Configuration saved, but field mappings failed: ${error.message}`
            : "Configuration saved, but field mappings failed to save.",
        );
        return;
      }
    }

    toast.success("Event type configuration saved");
    onOpenChange(false);
    onSuccess?.();
  };

  const isSubmitting = form.formState.isSubmitting;
  const watchSocialField = form.watch("socialHandleField");
  const isSocialFieldSelected =
    watchSocialField && watchSocialField !== NONE_VALUE;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Event Type</DialogTitle>
          <DialogDescription>
            Display, program mapping, payment links, and Calendly form field
            mappings for <strong>{config.displayName}</strong>.
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
            <section className="flex flex-col gap-4">
              <h3 className="text-sm font-semibold">General</h3>

              <FormField
                control={form.control}
                name="displayName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display Name</FormLabel>
                    <FormControl>
                      <Input {...field} disabled={isSubmitting} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="bookingProgramId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Booked Program</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isSubmitting || programs === undefined}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select booked program" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value={NONE_VALUE}>Unmapped</SelectItem>
                          {programs?.map((program) => (
                            <SelectItem key={program._id} value={program._id}>
                              {program.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="bookingBaseUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Booking Base URL</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        disabled={isSubmitting}
                        placeholder="https://calendly.com/..."
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="isExtended"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-1">
                        <FormLabel>Extended scheduling</FormLabel>
                        <FormDescription>
                          Enable when this event type allows booking further in
                          advance.
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={isSubmitting}
                          aria-label="Extended scheduling event type"
                        />
                      </FormControl>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </section>

            <Separator />

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold">Payment Links</h3>
              <PaymentLinkEditor links={paymentLinks} onChange={setPaymentLinks} />
            </section>

            <Separator />

            <section className="flex flex-col gap-4">
              <div>
                <h3 className="text-sm font-semibold">Field Mappings</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {mappingsAvailable ? (
                    <>
                      Map Calendly form questions to CRM identity fields.{" "}
                      {config.bookingCount ?? 0} booking
                      {(config.bookingCount ?? 0) === 1 ? "" : "s"} ·{" "}
                      {fieldCount} form field{fieldCount === 1 ? "" : "s"}{" "}
                      discovered.
                    </>
                  ) : (
                    "Form fields appear after the first booking syncs for this event type."
                  )}
                </p>
              </div>

              {mappingsAvailable ? (
                <>
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
                          Which form question asks for the lead&apos;s social
                          media handle?
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
                          Which social media platform does this handle belong
                          to?
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
                          Override if the lead&apos;s phone number is captured
                          in a custom form field instead of Calendly&apos;s
                          built-in phone field.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              ) : null}
            </section>

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
                {isSubmitting ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
