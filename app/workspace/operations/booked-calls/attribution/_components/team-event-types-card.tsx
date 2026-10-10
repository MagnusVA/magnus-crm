"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  READINESS_LABEL,
  type PortalReadiness,
  portalReadinessFor,
} from "@/app/workspace/_components/portal-readiness";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { SCHEDULING_MODE_LABEL } from "@/lib/scheduling-mode";

type SchedulingMode = "normal" | "extended";
type EventTypeConfig = Doc<"eventTypeConfigs"> & {
  portalReadiness?: PortalReadiness;
};
type Route = Doc<"teamProgramEventTypes">;

const MODES: Array<{ mode: SchedulingMode; label: string }> = [
  { mode: "normal", label: SCHEDULING_MODE_LABEL.normal },
  { mode: "extended", label: SCHEDULING_MODE_LABEL.extended },
];

const NOT_ASSIGNED = "__not_assigned__";

function modeOf(config: EventTypeConfig): SchedulingMode {
  return config.isExtended === true ? "extended" : "normal";
}

function cellKey(programId: string, mode: SchedulingMode) {
  return `${programId}:${mode}`;
}

export function TeamEventTypesCard({
  eventTypeConfigs,
}: {
  eventTypeConfigs: EventTypeConfig[];
}) {
  const teams = useQuery(api.attribution.teams.listTeams, {});
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {});
  const routes = useQuery(
    api.attribution.teamProgramEventTypes.listTeamProgramEventTypes,
    {},
  );
  const setRoute = useMutation(
    api.attribution.teamProgramEventTypes.setTeamProgramEventType,
  );
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [pendingCell, setPendingCell] = useState<string | null>(null);

  if (teams === undefined || programs === undefined || routes === undefined) {
    return (
      <Skeleton
        className="h-72 w-full"
        role="status"
        aria-label="Loading team event types"
      />
    );
  }

  const activeTeams = teams.filter((team) => team.isActive);
  const team =
    activeTeams.find((row) => row._id === selectedTeamId) ?? activeTeams[0];
  const eventTypeById = new Map(
    eventTypeConfigs.map((config) => [config._id, config]),
  );
  const routedEventTypeIds = new Set(
    routes.map((route) => route.eventTypeConfigId),
  );
  const teamRoutes = team
    ? routes.filter((route) => route.teamId === team._id)
    : [];
  const routeByCell = new Map(
    teamRoutes.map((route) => [cellKey(route.programId, route.mode), route]),
  );
  const sharedCount = eventTypeConfigs.filter(
    (config) =>
      !routedEventTypeIds.has(config._id) &&
      (config.portalReadiness ?? portalReadinessFor(config)) === "ready",
  ).length;

  async function handleChange(
    teamId: Id<"attributionTeams">,
    programId: Id<"tenantPrograms">,
    mode: SchedulingMode,
    value: string,
  ) {
    const key = cellKey(programId, mode);
    setPendingCell(key);
    try {
      await setRoute({
        teamId,
        programId,
        mode,
        eventTypeConfigId:
          value === NOT_ASSIGNED ? null : (value as Id<"eventTypeConfigs">),
      });
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not update team event type"));
    } finally {
      setPendingCell(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team Event Types</CardTitle>
        <CardDescription>
          Pick the event type each team&apos;s portal links book into, per
          program and scheduling mode.
        </CardDescription>
        {activeTeams.length > 0 && team ? (
          <CardAction>
            <Select
              value={team._id}
              onValueChange={(value) => setSelectedTeamId(value)}
            >
              <SelectTrigger aria-label="Team" className="w-52">
                <SelectValue placeholder="Select team" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {activeTeams.map((row) => (
                    <SelectItem key={row._id} value={row._id}>
                      {row.displayName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!team ? (
          <p className="text-sm text-muted-foreground">
            Create an active team to assign event types.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
              {teamRoutes.length > 0 ? (
                <Badge variant="secondary">
                  Own event types · {teamRoutes.length}
                </Badge>
              ) : (
                <Badge variant="outline">
                  Shared event types · {sharedCount}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {teamRoutes.length > 0
                  ? `${team.displayName}'s DM closers only see the event types assigned below.`
                  : `${team.displayName} sees every portal-ready event type no team is assigned to. Assigning one switches it to its own set.`}
              </span>
            </div>
            <div className="overflow-hidden rounded-lg border">
              <Table className="table-fixed">
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[30%] pl-3">Program</TableHead>
                    {MODES.map(({ mode, label }) => (
                      <TableHead key={mode}>{label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {programs.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={3}
                        className="h-24 text-center text-muted-foreground"
                      >
                        No programs are available.
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {programs.map((program) => (
                    <TableRow key={program._id}>
                      <TableCell
                        className="truncate pl-3 font-medium"
                        title={program.name}
                      >
                        {program.name}
                      </TableCell>
                      {MODES.map(({ mode, label }) => (
                        <TableCell key={mode}>
                          <RouteCell
                            options={eventTypeConfigs.filter(
                              (config) =>
                                config.bookingProgramId === program._id &&
                                config.bookingProgramMappingStatus ===
                                  "mapped" &&
                                modeOf(config) === mode,
                            )}
                            route={routeByCell.get(cellKey(program._id, mode))}
                            eventTypeById={eventTypeById}
                            isPending={
                              pendingCell === cellKey(program._id, mode)
                            }
                            onChange={(value) =>
                              handleChange(team._id, program._id, mode, value)
                            }
                            label={`${program.name} ${label} event type for ${team.displayName}`}
                          />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RouteCell({
  options,
  route,
  eventTypeById,
  isPending,
  onChange,
  label,
}: {
  options: EventTypeConfig[];
  route: Route | undefined;
  eventTypeById: Map<Id<"eventTypeConfigs">, EventTypeConfig>;
  isPending: boolean;
  onChange: (value: string) => void;
  label: string;
}) {
  const assigned = route ? eventTypeById.get(route.eventTypeConfigId) : null;
  // The event type was remapped to another program or mode after it was
  // assigned. The portal ignores the route until it's fixed.
  const isStale =
    route !== undefined &&
    !options.some((option) => option._id === route.eventTypeConfigId);
  const readiness = assigned
    ? (assigned.portalReadiness ?? portalReadinessFor(assigned))
    : null;

  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <div className="flex w-full min-w-0 items-center gap-2">
        <Select
          value={route?.eventTypeConfigId ?? NOT_ASSIGNED}
          onValueChange={onChange}
          disabled={isPending}
        >
          <SelectTrigger
            aria-label={label}
            className={cn(
              "w-full max-w-72 min-w-0",
              !route && "text-muted-foreground",
            )}
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={NOT_ASSIGNED}>Not assigned</SelectItem>
              {isStale && route ? (
                <SelectItem value={route.eventTypeConfigId}>
                  {assigned?.displayName ?? "Deleted event type"}
                </SelectItem>
              ) : null}
              {options.map((option) => (
                <SelectItem key={option._id} value={option._id}>
                  {option.displayName}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {isPending ? <Spinner /> : null}
      </div>
      {isStale ? (
        <Badge variant="destructive">No longer matches this program</Badge>
      ) : readiness && readiness !== "ready" ? (
        <Badge variant="destructive">{READINESS_LABEL[readiness]}</Badge>
      ) : null}
    </div>
  );
}
