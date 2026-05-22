"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  READINESS_LABEL,
  type PortalReadiness,
  portalReadinessFor,
  readinessBadgeVariant,
} from "./portal-readiness";

type EventTypeConfig = Doc<"eventTypeConfigs"> & {
  portalReadiness?: PortalReadiness;
};

export function PortalEventTypeReadinessCard({
  eventTypeConfigs,
}: {
  eventTypeConfigs: EventTypeConfig[];
}) {
  const setLinkPortalEnabled = useMutation(
    api.eventTypeConfigs.mutations.setLinkPortalEnabled,
  );
  const [pendingConfigId, setPendingConfigId] =
    useState<Id<"eventTypeConfigs"> | null>(null);

  async function handleToggle(
    eventTypeConfigId: Id<"eventTypeConfigs">,
    linkPortalEnabled: boolean,
  ) {
    setPendingConfigId(eventTypeConfigId);
    try {
      await setLinkPortalEnabled({
        eventTypeConfigId,
        linkPortalEnabled,
      });
      toast.success(
        linkPortalEnabled
          ? "Event type published to portal"
          : "Event type hidden from portal",
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not update event type visibility",
      );
    } finally {
      setPendingConfigId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Portal Event Types</CardTitle>
        <CardDescription>
          Publish only mapped, currently bookable Calendly event types with
          booking URLs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event Type</TableHead>
              <TableHead>Booked Program</TableHead>
              <TableHead>Base URL</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Readiness</TableHead>
              <TableHead className="text-right">Visible</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {eventTypeConfigs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="h-24 text-center text-muted-foreground"
                >
                  No event type configurations are available.
                </TableCell>
              </TableRow>
            ) : null}
            {eventTypeConfigs.map((config) => {
              const readiness =
                config.portalReadiness ?? portalReadinessFor(config);
              const isPending = pendingConfigId === config._id;
              return (
                <TableRow
                  key={config._id}
                  className={cn(
                    config.linkPortalEnabled === true && "bg-muted/35",
                  )}
                >
                  <TableCell>{config.displayName}</TableCell>
                  <TableCell>
                    {config.bookingProgramName ?? "Unmapped"}
                  </TableCell>
                  <TableCell className="max-w-80 truncate font-mono text-xs">
                    {config.bookingBaseUrl ?? "-"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={config.isExtended ? "secondary" : "outline"}>
                      {config.isExtended ? "Extended" : "Normal"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={readinessBadgeVariant(readiness)}>
                      {READINESS_LABEL[readiness]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      {isPending ? <Spinner /> : null}
                      <Switch
                        checked={config.linkPortalEnabled === true}
                        disabled={isPending}
                        aria-label={`Toggle ${config.displayName} portal visibility`}
                        onCheckedChange={(linkPortalEnabled) =>
                          handleToggle(config._id, linkPortalEnabled)
                        }
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
