"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FieldGroup,
  Field,
  FieldLabel,
} from "@/components/ui/field";
import { PaymentLinkEditor } from "./payment-link-editor";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import posthog from "posthog-js";

interface PaymentLink {
  provider: string;
  label: string;
  url: string;
}

interface EventTypeConfig {
  _id?: string;
  calendlyEventTypeUri: string;
  displayName: string;
  paymentLinks?: PaymentLink[];
}

interface EventTypeConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: EventTypeConfig;
  onSuccess?: () => void;
}

export function EventTypeConfigDialog({
  open,
  onOpenChange,
  config,
  onSuccess,
}: EventTypeConfigDialogProps) {
  const [displayName, setDisplayName] = useState(config.displayName);
  const [paymentLinks, setPaymentLinks] = useState<PaymentLink[]>(
    config.paymentLinks || []
  );
  const [isSaving, setIsSaving] = useState(false);

  const upsertConfig = useMutation(
    api.eventTypeConfigs.mutations.upsertEventTypeConfig
  );

  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error("Display name is required");
      return;
    }

    setIsSaving(true);
    try {
      await upsertConfig({
        calendlyEventTypeUri: config.calendlyEventTypeUri,
        displayName,
        paymentLinks: paymentLinks.length > 0 ? paymentLinks : undefined,
      });

      posthog.capture("event_type_config_saved", {
        calendly_event_type_uri: config.calendlyEventTypeUri,
        payment_link_count: paymentLinks.length,
      });
      toast.success("Event type configuration saved");
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      posthog.captureException(error);
      toast.error(
        error instanceof Error ? error.message : "Failed to save configuration"
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Event Type Configuration</DialogTitle>
          <DialogDescription>
            Customize how this event type appears in your CRM
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="config-displayName">Display Name</FieldLabel>
              <Input
                id="config-displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={isSaving}
              />
            </Field>

          </FieldGroup>

          <div className="flex flex-col gap-3">
            <FieldLabel>Payment Links</FieldLabel>
            <PaymentLinkEditor
              links={paymentLinks}
              onChange={setPaymentLinks}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Spinner className="mr-2 size-4" />}
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
