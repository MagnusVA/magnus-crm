import { requireSystemAdmin } from "@/lib/auth";
import { AdminPageClient } from "./_components/admin-page-client";

export default async function AdminPage() {
  await requireSystemAdmin();
  return <AdminPageClient />;
}
