import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { OperationsPageClient } from "./_components/operations-page-client";
import { OperationsPageSkeleton } from "./_components/operations-page-skeleton";

export const unstable_instant = false;

export default async function OperationsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<OperationsPageSkeleton />}>
      <OperationsPageClient />
    </Suspense>
  );
}
