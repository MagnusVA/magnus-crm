import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { AttributionPageClient } from "./_components/attribution-page-client";
import { AttributionPageSkeleton } from "./_components/attribution-page-skeleton";

export const unstable_instant = false;

export default async function AttributionPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<AttributionPageSkeleton />}>
      <AttributionPageClient />
    </Suspense>
  );
}
