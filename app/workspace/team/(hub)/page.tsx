import { Suspense } from "react";
import { MemberCardHost } from "../_components/member-card/member-card-host";
import { MembersPageClient } from "../_components/members/members-page-client";
import { TeamSectionSkeleton } from "../_components/team-section-skeleton";

// Team › Members: one row per human who gets credit. The hub's layout renders
// the band and lets in the roles this page always did (tenant_master,
// tenant_admin). The member card (?member=<key>) opens over the list.
export default function TeamPage() {
  return (
    <Suspense fallback={<TeamSectionSkeleton label="Loading team members" />}>
      <MembersPageClient />
      <MemberCardHost />
    </Suspense>
  );
}
