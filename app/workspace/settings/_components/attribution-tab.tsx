"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AttributionTeamDialog } from "./attribution-team-dialog";
import { AttributionUnmappedPanel } from "./attribution-unmapped-panel";
import { BookingLinkMatrix } from "./booking-link-matrix";
import { CampaignPresetsCard } from "./campaign-presets-card";
import { DmCloserDialog } from "./dm-closer-dialog";
import { PortalAccessCard } from "./portal-access-card";
import { PortalEventTypeReadinessCard } from "./portal-event-type-readiness-card";
import { PortalUsageCard } from "./portal-usage-card";

type DialogState =
  | { kind: "team"; teamId?: Id<"attributionTeams"> }
  | { kind: "dmCloser"; dmCloserId?: Id<"dmClosers"> }
  | null;

export function AttributionTab() {
  const [dialog, setDialog] = useState<DialogState>(null);
  const teams = useQuery(api.attribution.teams.listTeams, {});
  const closers = useQuery(api.attribution.dmClosers.listDmClosers, {});
  const eventTypeConfigs = useQuery(
    api.eventTypeConfigs.queries.listEventTypeConfigs,
    {},
  );
  const setTeamActive = useMutation(api.attribution.teams.setTeamActive);
  const setDmCloserActive = useMutation(
    api.attribution.dmClosers.setDmCloserActive,
  );

  const selectedTeam = useMemo(
    () =>
      dialog?.kind === "team" && dialog.teamId
        ? teams?.find((team) => team._id === dialog.teamId)
        : undefined,
    [dialog, teams],
  );
  const selectedDmCloser = useMemo(
    () =>
      dialog?.kind === "dmCloser" && dialog.dmCloserId
        ? closers?.find((closer) => closer._id === dialog.dmCloserId)
        : undefined,
    [closers, dialog],
  );

  const registryLoaded = teams !== undefined && closers !== undefined;
  const matrixLoaded =
    teams !== undefined &&
    closers !== undefined &&
    eventTypeConfigs !== undefined;

  return (
    <div className="flex flex-col gap-4">
      <PortalAccessCard />
      <PortalUsageCard />

      <Alert>
        <AlertTitle>External DM attribution</AlertTitle>
        <AlertDescription>
          DM teams and DM closers normalize Calendly UTM values only. They do
          not create CRM accounts or WorkOS users.
        </AlertDescription>
      </Alert>

      {registryLoaded ? (
        <>
          <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">DM Teams</CardTitle>
                <Button size="sm" onClick={() => setDialog({ kind: "team" })}>
                  New Team
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>UTM Source</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {teams.map((team) => (
                      <TableRow key={team._id}>
                        <TableCell>{team.displayName}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {team.utmSource}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={team.isActive ? "secondary" : "outline"}
                          >
                            {team.isActive ? "Active" : "Disabled"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setDialog({ kind: "team", teamId: team._id })
                              }
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setTeamActive({
                                  teamId: team._id,
                                  isActive: !team.isActive,
                                })
                              }
                            >
                              {team.isActive ? "Disable" : "Enable"}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">DM Closers</CardTitle>
                <Button
                  size="sm"
                  onClick={() => setDialog({ kind: "dmCloser" })}
                  disabled={teams.length === 0}
                >
                  New DM Closer
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Team</TableHead>
                      <TableHead>UTM Medium</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {closers.map((closer) => (
                      <TableRow key={closer._id}>
                        <TableCell>{closer.displayName}</TableCell>
                        <TableCell>{closer.teamLabel}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {closer.utmMedium}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              closer.isActive ? "secondary" : "outline"
                            }
                          >
                            {closer.isActive ? "Active" : "Disabled"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setDialog({
                                  kind: "dmCloser",
                                  dmCloserId: closer._id,
                                })
                              }
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setDmCloserActive({
                                  dmCloserId: closer._id,
                                  isActive: !closer.isActive,
                                })
                              }
                            >
                              {closer.isActive ? "Disable" : "Enable"}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <AttributionTeamDialog
            open={dialog?.kind === "team"}
            onOpenChange={(open) => !open && setDialog(null)}
            team={selectedTeam}
          />
          <DmCloserDialog
            open={dialog?.kind === "dmCloser"}
            onOpenChange={(open) => !open && setDialog(null)}
            dmCloser={selectedDmCloser}
            teams={teams}
          />
        </>
      ) : (
        <AttributionRegistrySkeleton />
      )}

      <CampaignPresetsCard />

      {eventTypeConfigs === undefined ? (
        <Skeleton className="h-72 w-full" />
      ) : (
        <PortalEventTypeReadinessCard eventTypeConfigs={eventTypeConfigs} />
      )}

      <AttributionUnmappedPanel />

      {matrixLoaded ? (
        <BookingLinkMatrix
          teams={teams}
          closers={closers}
          eventTypeConfigs={eventTypeConfigs}
        />
      ) : (
        <Skeleton className="h-80 w-full" />
      )}
    </div>
  );
}

function AttributionRegistrySkeleton() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}
