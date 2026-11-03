"use client";

import type { Doc } from "@/convex/_generated/dataModel";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { cn } from "@/lib/utils";
import {
  READINESS_LABEL,
  type PortalReadiness,
  portalReadinessFor,
} from "@/app/workspace/_components/portal-readiness";
import { CODE, RuledTable, StatusWord, type StatusTone, TableSkeleton, Td, Th, Tr } from "./attribution-ui";

type DmCloserRow = Doc<"dmClosers"> & { teamLabel: string };
type EventTypeConfigRow = Doc<"eventTypeConfigs"> & {
  portalReadiness?: PortalReadiness;
};

const TITLE = "Booked program link matrix";
const HEADS = ["Event type", "Booked program", "Base URL", "Portal", "Mapping"];

/** Published and bookable reads Visible; published but broken is red; otherwise amber or slate. */
function portalStatus(config: EventTypeConfigRow): { tone: StatusTone; word: string } {
  const readiness = config.portalReadiness ?? portalReadinessFor(config);
  const published = config.linkPortalEnabled === true;
  if (published && readiness === "ready") return { tone: "active", word: "Visible" };
  if (readiness === "hidden") return { tone: "inactive", word: READINESS_LABEL[readiness] };
  return { tone: published ? "broken" : "attention", word: READINESS_LABEL[readiness] };
}

function Figure({ value }: { value: number }) {
  return <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">{value}</span>;
}

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
    <DetailCard
      title={TITLE}
      className="min-w-0"
      meta={
        <span className="flex flex-wrap items-baseline gap-x-1">
          <span>
            <Figure value={activeTeams} /> active teams
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <Figure value={activeClosers} /> active DM closers
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <Figure value={eventTypeConfigs.length} /> event types
          </span>
        </span>
      }
    >
      {eventTypeConfigs.length === 0 ? (
        <SectionEmpty title="No event type configurations are available." />
      ) : (
        <RuledTable label={TITLE}>
          <thead>
            <tr>
              {HEADS.map((head) => (
                <Th key={head}>{head}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {eventTypeConfigs.map((config) => {
              const portal = portalStatus(config);
              const mapped = config.bookingProgramMappingStatus === "mapped";
              return (
                <Tr key={config._id}>
                  <Td className="font-medium">{config.displayName}</Td>
                  <Td className={cn(!config.bookingProgramName && "text-muted-foreground")}>
                    {config.bookingProgramName ?? "Unmapped"}
                  </Td>
                  <Td className={cn(CODE, "max-w-80 truncate")} title={config.bookingBaseUrl} translate="no">
                    {config.bookingBaseUrl ?? <span className="text-muted-foreground">—</span>}
                  </Td>
                  <Td>
                    <StatusWord tone={portal.tone}>{portal.word}</StatusWord>
                  </Td>
                  <Td>
                    <StatusWord tone={mapped ? "active" : "inactive"}>
                      {config.bookingProgramMappingStatus ?? "unmapped"}
                    </StatusWord>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </RuledTable>
      )}
    </DetailCard>
  );
}

export function BookingLinkMatrixSkeleton() {
  return (
    <DetailCard title={TITLE} className="min-w-0">
      <TableSkeleton label="Loading the booked program link matrix" heads={HEADS} rows={5} />
    </DetailCard>
  );
}
