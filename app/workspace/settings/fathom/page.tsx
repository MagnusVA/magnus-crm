import { requireRole } from "@/lib/auth";
import { FathomPageClient } from "./_components/fathom-page-client";

export const instant = false;

/** Fathom's own settings page: the connection, members to link, recordings to assign and the second opinion. */
export default async function FathomSettingsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);
  return <FathomPageClient />;
}
