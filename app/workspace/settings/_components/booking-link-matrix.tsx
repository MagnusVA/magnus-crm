"use client";

import type { Doc } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
} from "./portal-readiness";

type DmCloserRow = Doc<"dmClosers"> & { teamLabel: string };
type EventTypeConfigRow = Doc<"eventTypeConfigs"> & {
  portalReadiness?: PortalReadiness;
};

export function BookingLinkMatrix({
  teams,
  closers,
  eventTypeConfigs,
}: {
  teams: Doc<"attributionTeams">[];
  closers: DmCloserRow[];
  eventTypeConfigs: EventTypeConfigRow[];
}) {
  const activeTeams = teams.filter((team) => team.isActive).length;
  const activeClosers = closers.filter((closer) => closer.isActive).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Booked Program Link Matrix</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">{activeTeams} active teams</Badge>
          <Badge variant="outline">{activeClosers} active DM closers</Badge>
          <Badge variant="outline">{eventTypeConfigs.length} event types</Badge>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event Type</TableHead>
              <TableHead>Booked Program</TableHead>
              <TableHead>Base URL</TableHead>
              <TableHead>Portal</TableHead>
              <TableHead>Mapping</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {eventTypeConfigs.map((config) => {
              const readiness =
                config.portalReadiness ?? portalReadinessFor(config);
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
                    <Badge
                      variant={
                        config.linkPortalEnabled === true &&
                        readiness === "ready"
                          ? "secondary"
                          : readiness === "hidden"
                            ? "outline"
                            : "destructive"
                      }
                    >
                      {config.linkPortalEnabled === true
                        ? readiness === "ready"
                          ? "Visible"
                          : READINESS_LABEL[readiness]
                        : READINESS_LABEL[readiness]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        config.bookingProgramMappingStatus === "mapped"
                          ? "secondary"
                          : "outline"
                      }
                    >
                      {config.bookingProgramMappingStatus ?? "unmapped"}
                    </Badge>
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
