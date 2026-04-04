"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Edit2Icon, CalendarIcon } from "lucide-react";

// Lazy-load dialog component that is only shown on user interaction
const EventTypeConfigDialog = dynamic(() =>
  import("./event-type-config-dialog").then((m) => ({
    default: m.EventTypeConfigDialog,
  })),
);

interface PaymentLink {
  provider: string;
  label: string;
  url: string;
}

interface EventTypeConfig {
  _id: string;
  calendlyEventTypeUri: string;
  displayName: string;
  paymentLinks?: PaymentLink[];
  roundRobinEnabled?: boolean;
}

interface EventTypeConfigListProps {
  configs: EventTypeConfig[];
  onSuccess?: () => void;
}

export function EventTypeConfigList({
  configs,
  onSuccess,
}: EventTypeConfigListProps) {
  const [selectedConfig, setSelectedConfig] =
    useState<EventTypeConfig | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleEdit = (config: EventTypeConfig) => {
    setSelectedConfig(config);
    setDialogOpen(true);
  };

  const handleSuccess = () => {
    setDialogOpen(false);
    setSelectedConfig(null);
    onSuccess?.();
  };

  if (configs.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarIcon />
          </EmptyMedia>
          <EmptyTitle>No event types configured</EmptyTitle>
          <EmptyDescription>
            Connect Calendly and your event types will appear here automatically.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        {configs.map((config) => (
          <Card key={config._id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <CardTitle className="text-base">
                  {config.displayName}
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleEdit(config)}
                  aria-label={`Edit ${config.displayName} configuration`}
                >
                  <Edit2Icon />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Payment Links</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {config.paymentLinks && config.paymentLinks.length > 0 ? (
                    config.paymentLinks.map((link) => (
                      <Badge
                        key={`${link.provider}-${link.label}`}
                        variant="secondary"
                      >
                        {link.provider}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      None configured
                    </span>
                  )}
                </div>
              </div>

              <div className="border-t pt-3">
                <p className="text-xs text-muted-foreground">Round Robin</p>
                <p className="mt-1 text-sm font-medium">
                  {config.roundRobinEnabled ? "Enabled" : "Disabled"}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {selectedConfig && (
        <EventTypeConfigDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          config={selectedConfig}
          onSuccess={handleSuccess}
        />
      )}
    </>
  );
}
