"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { InfoIcon, Settings2Icon, CalendarIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatDistanceToNow } from "date-fns";

// Lazy-load dialog — only rendered on user interaction
const FieldMappingDialog = dynamic(() =>
  import("./field-mapping-dialog").then((m) => ({
    default: m.FieldMappingDialog,
  })),
);

interface CustomFieldMappings {
  socialHandleField?: string;
  socialHandleType?: "instagram" | "tiktok" | "twitter" | "other_social";
  phoneField?: string;
}

interface EventTypeConfigWithStats {
  _id: string;
  calendlyEventTypeUri: string;
  displayName: string;
  customFieldMappings?: CustomFieldMappings;
  knownCustomFieldKeys?: string[];
  bookingCount: number;
  lastBookingAt?: number;
  fieldCount: number;
}

interface FieldMappingsTabProps {
  configs: EventTypeConfigWithStats[];
}

const SOCIAL_PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  twitter: "X (Twitter)",
  other_social: "Other",
};

export function FieldMappingsTab({ configs }: FieldMappingsTabProps) {
  const [selectedConfig, setSelectedConfig] =
    useState<EventTypeConfigWithStats | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleConfigure = (config: EventTypeConfigWithStats) => {
    setSelectedConfig(config);
    setDialogOpen(true);
  };

  const handleSuccess = () => {
    setDialogOpen(false);
    setSelectedConfig(null);
  };

  if (configs.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarIcon />
          </EmptyMedia>
          <EmptyTitle>No event types yet</EmptyTitle>
          <EmptyDescription>
            Event types appear here after their first booking. Connect Calendly
            and wait for incoming bookings to auto-discover form fields.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <InfoIcon className="size-4" />
        <AlertDescription>
          Configure how your CRM identifies leads from booking form data.
          Event types and their form questions are managed in Calendly —
          field names below are auto-discovered from actual bookings.
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-3">
        {configs.map((config) => {
          const hasMappings = !!(
            config.customFieldMappings?.socialHandleField ||
            config.customFieldMappings?.phoneField
          );

          return (
            <Card key={config._id}>
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex flex-col gap-1">
                  <p className="font-medium">{config.displayName}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    {config.lastBookingAt && (
                      <span>
                        Last booking:{" "}
                        {formatDistanceToNow(config.lastBookingAt, {
                          addSuffix: true,
                        })}
                      </span>
                    )}
                    <span>
                      {config.bookingCount}{" "}
                      {config.bookingCount === 1 ? "booking" : "bookings"}
                    </span>
                    <span>
                      {config.fieldCount}{" "}
                      {config.fieldCount === 1 ? "form field" : "form fields"}
                    </span>
                  </div>
                  {hasMappings && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {config.customFieldMappings?.socialHandleField && (
                        <Badge variant="secondary">
                          {SOCIAL_PLATFORM_LABELS[
                            config.customFieldMappings.socialHandleType ??
                              "other_social"
                          ] ?? "Social"}{" "}
                          mapped
                        </Badge>
                      )}
                      {config.customFieldMappings?.phoneField && (
                        <Badge variant="secondary">Phone mapped</Badge>
                      )}
                    </div>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleConfigure(config)}
                  disabled={config.fieldCount === 0}
                  aria-label={`Configure field mappings for ${config.displayName}`}
                >
                  <Settings2Icon className="mr-2 size-4" />
                  Configure
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {selectedConfig && (
        <FieldMappingDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          config={selectedConfig}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}
