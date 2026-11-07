import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { AttributionPageClient } from "./_components/attribution-page-client";

export const unstable_instant = false;

/**
 * Attribution keeps only its checks (pipeline recovery and unmatched UTMs).
 * DM teams and the link portal moved to Booking setup; old links follow.
 */
export default async function AttributionPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const { section } = await searchParams;
  if (section === "portal") {
    redirect("/workspace/booking/portal");
  }
  if (section !== "diagnostics") {
    redirect("/workspace/team/teams");
  }
  await requireRole(["tenant_master", "tenant_admin"]);

  return <AttributionPageClient />;
}
