"use client";

import { useEffect, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { AlertCircleIcon } from "lucide-react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
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
import { FieldGroup } from "@/components/ui/field";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

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

  useEffect(() => {
    if (open) {
      form.reset({
        label: campaign?.label ?? "",
        utmCampaign: campaign?.utmCampaign ?? "",
      });
      setSubmitError(null);
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
        error instanceof Error ? error.message : "Campaign preset could not be saved.",
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
            {campaign ? "Edit Campaign Preset" : "New Campaign Preset"}
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

        <Form {...form}>
          <form
            id="campaign-preset-form"
            onSubmit={form.handleSubmit(onSubmit)}
          >
            <FieldGroup>
              <FormField
                control={form.control}
                name="label"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Label</FormLabel>
                    <FormControl>
                      <Input {...field} disabled={isSubmitting} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="utmCampaign"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>UTM Campaign</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        disabled={isSubmitting}
                        className="font-mono"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldGroup>
          </form>
        </Form>

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
            {campaign ? "Save Campaign" : "Create Campaign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
