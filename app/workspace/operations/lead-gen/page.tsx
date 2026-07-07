import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { LeadGenAdminPageClient } from "./_components/lead-gen-admin-page-client";
import { LeadGenAdminSkeleton } from "./_components/lead-gen-admin-skeleton";

export const unstable_instant = false;

export default async function LeadGenAdminPage() {
  await requirePermission("lead-gen:view-all");

  return (
    <Suspense fallback={<LeadGenAdminSkeleton />}>
      <LeadGenAdminPageClient />
    </Suspense>
  );
}
