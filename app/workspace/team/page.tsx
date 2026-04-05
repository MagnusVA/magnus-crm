import { requireRole } from "@/lib/auth";
import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { TeamPageClient } from "./_components/team-page-client";

export default async function TeamPage() {
  const { session, crmUser } = await requireRole(ADMIN_ROLES);
  const preloadedTeam = await preloadQuery(
    api.users.queries.listTeamMembers,
    {},
    { token: session.accessToken },
  );
  return (
    <TeamPageClient
      preloadedTeam={preloadedTeam}
      currentUserId={crmUser._id}
    />
  );
}
