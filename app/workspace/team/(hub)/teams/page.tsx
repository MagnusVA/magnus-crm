import { Suspense } from "react";
import { TeamsPageClient } from "../../_components/teams/teams-page-client";
import { TeamsTableSkeleton } from "../../_components/teams/teams-table";

export default function TeamTeamsPage() {
  return (
    <Suspense fallback={<TeamsTableSkeleton />}>
      <TeamsPageClient />
    </Suspense>
  );
}
