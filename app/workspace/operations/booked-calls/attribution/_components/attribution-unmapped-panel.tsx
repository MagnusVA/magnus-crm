"use client";

import { useQuery } from "convex/react";
import { formatDistanceToNow } from "date-fns";
import { api } from "@/convex/_generated/api";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { cn } from "@/lib/utils";
import { CardNote, CODE, RuledTable, TableSkeleton, Td, Th, Tr } from "./attribution-ui";

const TITLE = "Recent unmapped UTMs";
const HEADS = ["Scheduled", "UTM source", "UTM medium", "Campaign"];

/** A UTM value in code type, or a slate dash when the booking had none. */
function UtmValue({ value }: { value: string | undefined }) {
  return value === undefined ? (
    <span className="text-muted-foreground">—</span>
  ) : (
    <span translate="no">{value}</span>
  );
}

export function AttributionUnmappedPanel() {
  const unmapped = useQuery(api.operations.unmappedUtms.listRecentUnmappedUtms, {});

  if (unmapped === undefined) {
    return (
      <DetailCard title={TITLE} className="min-w-0">
        <TableSkeleton label="Loading unmapped UTMs" heads={HEADS} rows={3} />
      </DetailCard>
    );
  }

  return (
    <DetailCard
      title={TITLE}
      className="min-w-0"
      meta={
        <span>
          <span className={cn("font-condensed text-[15px] font-semibold tabular-nums", unmapped.length > 0 && "text-foreground")}>
            {unmapped.length}
          </span>{" "}
          unmapped
        </span>
      }
    >
      <CardNote>
        Create or update a canonical DM team and DM closer to map future
        bookings.
      </CardNote>
      {unmapped.length === 0 ? (
        <SectionEmpty title="No unmapped external UTM values in the last 30 days." />
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
            {unmapped.map((row) => (
              <Tr key={row.meetingId}>
                <Td className="whitespace-nowrap">
                  {formatDistanceToNow(row.scheduledAt, { addSuffix: true })}
                </Td>
                <Td className={CODE}>
                  <UtmValue value={row.utmSource ?? undefined} />
                </Td>
                <Td className={CODE}>
                  <UtmValue value={row.utmMedium ?? undefined} />
                </Td>
                <Td className={CODE}>
                  <UtmValue value={row.utmCampaign ?? undefined} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </RuledTable>
      )}
    </DetailCard>
  );
}
