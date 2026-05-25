import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { LeadGenActivityPageClient } from "../_components/lead-gen-activity-page-client";
import { LeadGenActivitySkeleton } from "../_components/lead-gen-activity-skeleton";

export const unstable_instant = false;

export default async function LeadGenMyActivityPage() {
  await requirePermission("lead-gen:view-own");

  return (
    <Suspense fallback={<LeadGenActivitySkeleton />}>
      <LeadGenActivityPageClient />
    </Suspense>
  );
}
