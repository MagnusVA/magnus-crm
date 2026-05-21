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

type PortalReadiness =
  | "ready"
  | "missing_url"
  | "unmapped_program"
  | "hidden";

type EventTypeConfig = Doc<"eventTypeConfigs"> & {
  portalReadiness?: PortalReadiness;
};

const READINESS_LABEL: Record<PortalReadiness, string> = {
  ready: "Ready",
  missing_url: "Missing URL",
  unmapped_program: "Unmapped program",
  hidden: "Hidden",
};

function readinessFor(config: EventTypeConfig): PortalReadiness {
  const hasMappedProgram =
    config.bookingProgramId !== undefined &&
    config.bookingProgramMappingStatus === "mapped";

  if (config.linkPortalEnabled === true && config.bookingBaseUrl && hasMappedProgram) {
    return "ready";
  }
  if (!config.bookingBaseUrl && hasMappedProgram) {
    return "missing_url";
  }
  if (config.bookingBaseUrl && !hasMappedProgram) {
    return "unmapped_program";
  }
  return "hidden";
}

function readinessBadgeVariant(readiness: PortalReadiness) {
  if (readiness === "ready") {
    return "secondary" as const;
  }
  if (readiness === "hidden") {
    return "outline" as const;
  }
  return "destructive" as const;
}

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
          Publish only mapped Calendly event types with booking URLs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event Type</TableHead>
              <TableHead>Booked Program</TableHead>
              <TableHead>Base URL</TableHead>
              <TableHead>Readiness</TableHead>
              <TableHead className="text-right">Visible</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {eventTypeConfigs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-muted-foreground"
                >
                  No event type configurations are available.
                </TableCell>
              </TableRow>
            ) : null}
            {eventTypeConfigs.map((config) => {
              const readiness = config.portalReadiness ?? readinessFor(config);
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
