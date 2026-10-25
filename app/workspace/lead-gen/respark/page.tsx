import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { LeadGenResparkPageClient } from "../_components/lead-gen-respark-page-client";
import { LeadGenResparkSkeleton } from "../_components/lead-gen-respark-skeleton";

export const unstable_instant = false;

export default async function LeadGenResparkPage() {
  await requirePermission("lead-gen:respark");

  return (
    <Suspense fallback={<LeadGenResparkSkeleton />}>
      <LeadGenResparkPageClient />
    </Suspense>
  );
}
