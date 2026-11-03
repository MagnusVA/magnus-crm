import { Suspense } from "react";
import { TeamPageClient, TeamPageSkeleton } from "../../_components/teams/team-page-client";

export default function BookingTeamPage() {
  return (
    <Suspense fallback={<TeamPageSkeleton />}>
      <TeamPageClient />
    </Suspense>
  );
}
