import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import { requireRole } from "@/lib/auth";
import { DashboardPageClient } from "./_components/dashboard-page-client";

export default async function AdminDashboardPage() {
  const { crmUser } = await requireRole(ADMIN_ROLES);

  return (
    <DashboardPageClient displayName={crmUser.fullName ?? crmUser.email} />
  );
}
