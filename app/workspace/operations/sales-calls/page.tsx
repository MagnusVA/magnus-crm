import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { SalesCallsPageClient } from "./_components/sales-calls-page-client";
import { SalesCallsPageSkeleton } from "./_components/sales-calls-page-skeleton";

export const unstable_instant = false;

export default async function OperationsSalesCallsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<SalesCallsPageSkeleton />}>
      <SalesCallsPageClient />
    </Suspense>
  );
}
