"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PaymentLinkEditor } from "./payment-link-editor";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { getErrorMessage } from "@/lib/errors";
import {
  ACTION_DIALOG_WIDE,
  ACTION_FORM,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  FormRow,
  FormRows,
  SubmitButton,
  SubmitError,
} from "@/app/workspace/_components/action-dialog";

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

// Calendly form questions can be long sentences; keep them from widening the form.
const SELECT_TRIGGER_CLASS =
  "w-full *:data-[slot=select-value]:block *:data-[slot=select-value]:truncate";
const FORM_FIELD_SELECT_CONTENT_CLASS =
  "max-w-(--radix-select-trigger-width)";

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
  const ids = useId();
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

  // Each time the dialog opens, or the config changes while open, start over
  // from the saved links with no error.
  const [synced, setSynced] = useState({ open, config });
  if (synced.open !== open || synced.config !== config) {
    setSynced({ open, config });
    if (open) {
      setPaymentLinks(config.paymentLinks || []);
      setSubmitError(null);
    }
  }

  useEffect(() => {
    if (open) {
      form.reset(defaultsFromConfig(config));
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
      reportClientError(error, { flow: "event_type_config_save" });
      setSubmitError(
        getErrorMessage(error, "Failed to save configuration"),
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
        reportClientError(error, { flow: "event_type_field_mappings_save" });
        setSubmitError(
          `Configuration saved, but field mappings failed: ${getErrorMessage(error, "unknown error")}`,
        );
        return;
      }
    }

    toast.success("Event type configuration saved");
    onOpenChange(false);
    onSuccess?.();
  };

  const isSubmitting = form.formState.isSubmitting;
  const watchSocialField = useWatch({ control: form.control, name: "socialHandleField" });
  const isSocialFieldSelected =
    watchSocialField && watchSocialField !== NONE_VALUE;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!isSubmitting) onOpenChange(next);
      }}
    >
      <DialogContent className={ACTION_DIALOG_WIDE} showCloseButton={!isSubmitting}>
        <ActionDialogHeader
          title={`Edit ${config.displayName}`}
          description="Its name, booked program, payment links and form field mappings."
        />

        <form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM}>
          <SubmitError>{submitError}</SubmitError>
          <FormRows>
            <Controller
              control={form.control}
              name="displayName"
              render={({ field, fieldState }) => (
                <FormRow label="Display name" htmlFor={`${ids}-name`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Input
                    {...field}
                    id={`${ids}-name`}
                    autoComplete="off"
                    aria-invalid={fieldState.invalid}
                    disabled={isSubmitting}
                  />
                </FormRow>
              )}
            />

            <Controller
              control={form.control}
              name="bookingProgramId"
              render={({ field, fieldState }) => (
                <FormRow label="Booked program" htmlFor={`${ids}-program`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={isSubmitting || programs === undefined}
                  >
                    <SelectTrigger id={`${ids}-program`} aria-invalid={fieldState.invalid} className={SELECT_TRIGGER_CLASS}>
                      <SelectValue placeholder="Select booked program" />
                    </SelectTrigger>
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
                </FormRow>
              )}
            />

            <Controller
              control={form.control}
              name="bookingBaseUrl"
              render={({ field, fieldState }) => (
                <FormRow label="Booking base URL" htmlFor={`${ids}-url`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Input
                    {...field}
                    id={`${ids}-url`}
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://calendly.com/..."
                    className="text-[13px]"
                    aria-invalid={fieldState.invalid}
                    disabled={isSubmitting}
                  />
                </FormRow>
              )}
            />

            <Controller
              control={form.control}
              name="isExtended"
              render={({ field, fieldState }) => (
                <FormRow
                  label="Standard scheduling"
                  htmlFor={`${ids}-extended`}
                  invalid={fieldState.invalid}
                  error={fieldState.error}
                  description="Turn on when this event type books further in advance. Leave off for Priority event types."
                >
                  <div className="flex min-h-8 items-center">
                    <Switch
                      id={`${ids}-extended`}
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={isSubmitting}
                    />
                  </div>
                </FormRow>
              )}
            />

            <SectionTitle>Payment links</SectionTitle>
            <div className="px-4 py-3">
              <PaymentLinkEditor links={paymentLinks} onChange={setPaymentLinks} disabled={isSubmitting} />
            </div>

            <SectionTitle
              meta={
                mappingsAvailable ? (
                  <>
                    {config.bookingCount !== undefined
                      ? `${config.bookingCount} booking${config.bookingCount === 1 ? "" : "s"} · `
                      : null}
                    {fieldCount} form field{fieldCount === 1 ? "" : "s"} found
                  </>
                ) : null
              }
            >
              Form field mappings
            </SectionTitle>
            {mappingsAvailable ? (
              <>
                <Controller
                  control={form.control}
                  name="socialHandleField"
                  render={({ field, fieldState }) => (
                    <FormRow
                      label="Social handle"
                      htmlFor={`${ids}-social`}
                      invalid={fieldState.invalid}
                      error={fieldState.error}
                      description="The form question that asks for the lead's social handle."
                    >
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                        disabled={isSubmitting}
                      >
                        <SelectTrigger id={`${ids}-social`} aria-invalid={fieldState.invalid} className={SELECT_TRIGGER_CLASS}>
                          <SelectValue placeholder="Select a form field..." />
                        </SelectTrigger>
                        <SelectContent
                          position="popper"
                          className={FORM_FIELD_SELECT_CONTENT_CLASS}
                        >
                          <SelectItem value={NONE_VALUE}>(none)</SelectItem>
                          {knownKeys.map((key) => (
                            <SelectItem key={key} value={key}>
                              {key}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormRow>
                  )}
                />

                <Controller
                  control={form.control}
                  name="socialHandleType"
                  render={({ field, fieldState }) => (
                    <FormRow
                      label="Platform"
                      htmlFor={`${ids}-platform`}
                      invalid={fieldState.invalid}
                      error={fieldState.error}
                      description="The platform that handle belongs to."
                    >
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                        disabled={isSubmitting || !isSocialFieldSelected}
                      >
                        <SelectTrigger id={`${ids}-platform`} aria-invalid={fieldState.invalid} className={SELECT_TRIGGER_CLASS}>
                          <SelectValue placeholder="Select platform..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE_VALUE}>(none)</SelectItem>
                          {SOCIAL_PLATFORMS.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormRow>
                  )}
                />

                <Controller
                  control={form.control}
                  name="phoneField"
                  render={({ field, fieldState }) => (
                    <FormRow
                      label="Phone"
                      htmlFor={`${ids}-phone`}
                      invalid={fieldState.invalid}
                      error={fieldState.error}
                      description="Only when the phone number comes from a custom question instead of Calendly's own phone field."
                    >
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                        disabled={isSubmitting}
                      >
                        <SelectTrigger id={`${ids}-phone`} aria-invalid={fieldState.invalid} className={SELECT_TRIGGER_CLASS}>
                          <SelectValue placeholder="Select a form field..." />
                        </SelectTrigger>
                        <SelectContent
                          position="popper"
                          className={FORM_FIELD_SELECT_CONTENT_CLASS}
                        >
                          <SelectItem value={NONE_VALUE}>(none)</SelectItem>
                          {knownKeys.map((key) => (
                            <SelectItem key={key} value={key}>
                              {key}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormRow>
                  )}
                />
              </>
            ) : (
              <p className="px-4 py-3 text-[13px] leading-[1.45] text-muted-foreground">
                Form fields appear after the first booking syncs for this event type.
              </p>
            )}
          </FormRows>

          <ActionDialogFooter>
            <CancelButton onClick={() => onOpenChange(false)} disabled={isSubmitting} />
            <SubmitButton pending={isSubmitting} pendingLabel="Saving…">
              Save event type
            </SubmitButton>
          </ActionDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A 44px section title inside the ruled rows, with optional slate meta on the right. */
function SectionTitle({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-4 py-2">
      <h3 className="text-[15px] font-semibold">{children}</h3>
      {meta ? <p className="text-[13px] text-muted-foreground tabular-nums">{meta}</p> : null}
    </div>
  );
}
