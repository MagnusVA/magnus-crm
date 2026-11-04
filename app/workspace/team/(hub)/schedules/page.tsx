import { Suspense } from "react";
import { MemberCardHost } from "../../_components/member-card/member-card-host";
import { SchedulesPageClient } from "../../_components/schedules/schedules-page-client";
import { TeamSectionSkeleton } from "../../_components/team-section-skeleton";

export default function TeamSchedulesPage() {
  return (
    <Suspense fallback={<TeamSectionSkeleton label="Loading schedules" />}>
      <SchedulesPageClient />
      <MemberCardHost />
    </Suspense>
  );
}
