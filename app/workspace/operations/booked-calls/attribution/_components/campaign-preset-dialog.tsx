"use client";

import { useEffect, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { AlertCircleIcon } from "lucide-react";
import { useMutation } from "convex/react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage } from "@/lib/errors";

const campaignPresetSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(40),
  utmCampaign: z
    .string()
    .trim()
    .min(1, "UTM campaign is required")
    .max(40, "UTM campaign must be 40 characters or fewer"),
});

type CampaignPresetForDialog = {
  _id: Id<"linkPortalCampaignPresets">;
  label: string;
  utmCampaign: string;
};

export function CampaignPresetDialog({
  open,
  campaign,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  campaign?: CampaignPresetForDialog;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}) {
  const createCampaign = useMutation(
    api.linkPortal.campaignMutations.createCampaignPreset,
  );
  const updateCampaign = useMutation(
    api.linkPortal.campaignMutations.updateCampaignPreset,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const form = useForm({
    resolver: standardSchemaResolver(campaignPresetSchema),
    defaultValues: {
      label: "",
      utmCampaign: "",
    },
  });

  // Clear any previous error each time the dialog opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSubmitError(null);
  }

  useEffect(() => {
    if (open) {
      form.reset({
        label: campaign?.label ?? "",
        utmCampaign: campaign?.utmCampaign ?? "",
      });
    }
  }, [campaign, form, open]);

  async function onSubmit(values: z.infer<typeof campaignPresetSchema>) {
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      if (campaign) {
        await updateCampaign({
          campaignPresetId: campaign._id,
          label: values.label,
          utmCampaign: values.utmCampaign,
        });
      } else {
        await createCampaign({
          label: values.label,
          utmCampaign: values.utmCampaign,
        });
      }
      onSuccess?.();
      onOpenChange(false);
    } catch (error) {
      setSubmitError(
        getErrorMessage(error, "Campaign preset could not be saved."),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {campaign ? "Edit campaign preset" : "New campaign preset"}
          </DialogTitle>
          <DialogDescription>
            Campaign presets populate the generated Calendly UTM campaign value.
          </DialogDescription>
        </DialogHeader>

        {submitError ? (
          <Alert variant="destructive">
            <AlertCircleIcon data-icon="inline-start" />
            <AlertTitle>Campaign not saved</AlertTitle>
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        ) : null}

        <form
          id="campaign-preset-form"
          onSubmit={form.handleSubmit(onSubmit)}
        >
          <FieldGroup>
            <Controller
              control={form.control}
              name="label"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="campaign-preset-label">Label</FieldLabel>
                  <Input
                    {...field}
                    id="campaign-preset-label"
                    aria-invalid={fieldState.invalid}
                    disabled={isSubmitting}
                  />
                  <FieldError className="text-[13px] text-danger-ink" errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="utmCampaign"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="campaign-preset-utm">UTM campaign</FieldLabel>
                  <Input
                    {...field}
                    id="campaign-preset-utm"
                    aria-invalid={fieldState.invalid}
                    disabled={isSubmitting}
                    className="font-mono"
                    translate="no"
                  />
                  <FieldError className="text-[13px] text-danger-ink" errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="campaign-preset-form"
            disabled={isSubmitting}
          >
            {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
            {campaign ? "Save campaign" : "Create campaign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
