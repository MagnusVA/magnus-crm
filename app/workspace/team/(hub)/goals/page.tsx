import { Suspense } from "react";
import { GoalsPageClient } from "../../_components/goals/goals-page-client";
import { MemberCardHost } from "../../_components/member-card/member-card-host";
import { TeamSectionSkeleton } from "../../_components/team-section-skeleton";

export default function TeamGoalsPage() {
  return (
    <Suspense fallback={<TeamSectionSkeleton label="Loading goals" />}>
      <GoalsPageClient />
      <MemberCardHost />
    </Suspense>
  );
}
