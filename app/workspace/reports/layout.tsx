import { redirect } from "next/navigation";
import { hasPermission } from "@/convex/lib/permissions";
import { requireWorkspaceUser } from "@/lib/auth";

export default async function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await requireWorkspaceUser();

  if (!hasPermission(access.crmUser.role, "reports:view")) {
    redirect(access.crmUser.role === "closer" ? "/workspace/closer" : "/workspace");
  }

  return <>{children}</>;
}
