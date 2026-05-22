"use client";

import { useEffect, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  FieldGroup,
  Field,
  FieldLabel,
} from "@/components/ui/field";
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
  bookingProgramId?: Id<"tenantPrograms">;
  bookingBaseUrl?: string;
  isExtended?: boolean;
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
  const [bookingProgramId, setBookingProgramId] = useState<
    Id<"tenantPrograms"> | undefined
  >(config.bookingProgramId);
  const [bookingBaseUrl, setBookingBaseUrl] = useState(
    config.bookingBaseUrl ?? "",
  );
  const [isExtended, setIsExtended] = useState(config.isExtended === true);
  const [isSaving, setIsSaving] = useState(false);
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
    includeArchived: false,
  });

  const upsertConfig = useMutation(
    api.eventTypeConfigs.mutations.upsertEventTypeConfig
  );

  useEffect(() => {
    if (open) {
      setDisplayName(config.displayName);
      setPaymentLinks(config.paymentLinks || []);
      setBookingProgramId(config.bookingProgramId);
      setBookingBaseUrl(config.bookingBaseUrl ?? "");
      setIsExtended(config.isExtended === true);
    }
  }, [config, open]);

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
        bookingProgramId,
        bookingBaseUrl: bookingBaseUrl.trim() || undefined,
        isExtended,
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

            <Field>
              <FieldLabel>Booked Program</FieldLabel>
              <Select
                value={bookingProgramId ?? "unmapped"}
                onValueChange={(value) =>
                  setBookingProgramId(
                    value === "unmapped"
                      ? undefined
                      : (value as Id<"tenantPrograms">),
                  )
                }
                disabled={isSaving || programs === undefined}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select booked program" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="unmapped">Unmapped</SelectItem>
                    {programs?.map((program) => (
                      <SelectItem key={program._id} value={program._id}>
                        {program.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="booking-base-url">
                Booking Base URL
              </FieldLabel>
              <Input
                id="booking-base-url"
                value={bookingBaseUrl}
                onChange={(event) => setBookingBaseUrl(event.target.value)}
                disabled={isSaving}
                placeholder="https://calendly.com/..."
              />
            </Field>

            <Field>
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <FieldLabel htmlFor="is-extended">Extended scheduling</FieldLabel>
                  <p className="text-sm text-muted-foreground">
                    Enable when this event type allows booking further in advance.
                  </p>
                </div>
                <Switch
                  id="is-extended"
                  checked={isExtended}
                  onCheckedChange={setIsExtended}
                  disabled={isSaving}
                  aria-label="Extended scheduling event type"
                />
              </div>
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
