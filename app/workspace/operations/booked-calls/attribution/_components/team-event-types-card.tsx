"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  READINESS_LABEL,
  type PortalReadiness,
  portalReadinessFor,
} from "@/app/workspace/_components/portal-readiness";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { SCHEDULING_MODE_LABEL } from "@/lib/scheduling-mode";
import { CardNote, RuledTable, StatusWord, TableSkeleton, Td, Th, Tr } from "./attribution-ui";

const TITLE = "Team event types";

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
    return <TeamEventTypesSkeleton />;
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
    <DetailCard
      title={TITLE}
      className="@container/routes min-w-0"
      meta={
        activeTeams.length > 0 && team ? (
          <Select
            value={team._id}
            onValueChange={(value) => setSelectedTeamId(value)}
          >
            <SelectTrigger aria-label="Team" size="sm" className="w-52 text-[13px] text-foreground">
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
        ) : null
      }
    >
      <CardNote>
        Pick the event type each team&apos;s portal links book into, per
        program and scheduling mode.
      </CardNote>
      {!team ? (
        <SectionEmpty title="No active DM teams.">
          Create an active team to assign event types.
        </SectionEmpty>
      ) : (
        <>
          <div className="flex flex-col gap-0.5 px-4 py-2.5 text-[13px] @xl/routes:flex-row @xl/routes:items-baseline @xl/routes:gap-3">
            <span className="shrink-0 font-medium whitespace-nowrap">
              {teamRoutes.length > 0 ? "Own event types" : "Shared event types"}{" "}
              <span className="font-condensed text-[15px] font-semibold tabular-nums">
                {teamRoutes.length > 0 ? teamRoutes.length : sharedCount}
              </span>
            </span>
            <span className="text-muted-foreground">
              {teamRoutes.length > 0
                ? `${team.displayName}'s DM closers only see the event types assigned below.`
                : `${team.displayName} sees every portal-ready event type no team is assigned to. Assigning one switches it to its own set.`}
            </span>
          </div>
          {programs.length === 0 ? (
            <SectionEmpty className="border-t" title="No programs are available." />
          ) : (
            <RuledTable label={`${TITLE} for ${team.displayName}`} className="min-w-[36rem] table-fixed">
              <thead>
                <tr>
                  <Th className="w-[30%]">Program</Th>
                  {MODES.map(({ mode, label }) => (
                    <Th key={mode}>{label}</Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {programs.map((program) => (
                  <Tr key={program._id}>
                    <Td
                      className="truncate py-2 font-medium"
                      title={program.name}
                    >
                      {program.name}
                    </Td>
                    {MODES.map(({ mode, label }) => (
                      <Td key={mode} className="py-2">
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
                      </Td>
                    ))}
                  </Tr>
                ))}
              </tbody>
            </RuledTable>
          )}
        </>
      )}
    </DetailCard>
  );
}

export function TeamEventTypesSkeleton() {
  return (
    <DetailCard title={TITLE} className="min-w-0">
      <TableSkeleton
        label="Loading team event types"
        heads={["Program", ...MODES.map(({ label }) => label)]}
        rows={4}
        rowClassName="h-12"
      />
    </DetailCard>
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
        <StatusWord tone="broken" className="max-w-full">No longer matches this program</StatusWord>
      ) : readiness && readiness !== "ready" ? (
        <StatusWord tone="attention" className="max-w-full">{READINESS_LABEL[readiness]}</StatusWord>
      ) : null}
    </div>
  );
}
