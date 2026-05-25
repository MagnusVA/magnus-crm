import { requireRole } from "@/lib/auth";
import { TeamPageClient } from "./_components/team-page-client";

export const unstable_instant = false;

export default async function TeamPage() {
  await requireRole(["tenant_master", "tenant_admin"]);
  return <TeamPageClient />;
}
