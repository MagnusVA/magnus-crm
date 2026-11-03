import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { TableSkeleton } from "./attribution-ui";

export const TEAM_HEADS = ["Name", "UTM source", "Goal / day", "Status"];
export const CLOSER_HEADS = ["DM closer", "Team", "UTM medium", "Rate / h", "Status"];

export function DmTeamsCardSkeleton() {
  return (
    <DetailCard title="DM teams" className="min-w-0">
      <TableSkeleton label="Loading DM teams" heads={TEAM_HEADS} rows={3} />
    </DetailCard>
  );
}

export function DmClosersCardSkeleton() {
  return (
    <DetailCard title="DM closers" className="min-w-0">
      <TableSkeleton label="Loading DM closers" heads={CLOSER_HEADS} rows={4} />
    </DetailCard>
  );
}
