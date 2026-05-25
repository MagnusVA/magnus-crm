import { redirect } from "next/navigation";
import { requireWorkspaceUser } from "@/lib/auth";
import { DashboardPageClient } from "./_components/dashboard-page-client";

export const unstable_instant = false;

export default async function WorkspaceIndexPage() {
  const access = await requireWorkspaceUser();

  if (access.crmUser.role === "lead_generator") {
    redirect("/workspace/lead-gen/capture");
  }

  if (access.crmUser.role === "closer") {
    redirect("/workspace/closer");
  }

  return <DashboardPageClient />;
}
