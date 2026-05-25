import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { LeadGenCapturePageClient } from "../_components/lead-gen-capture-page-client";
import { LeadGenCaptureSkeleton } from "../_components/lead-gen-capture-skeleton";

export const unstable_instant = false;

export default async function LeadGenCapturePage() {
  await requirePermission("lead-gen:capture");

  return (
    <Suspense fallback={<LeadGenCaptureSkeleton />}>
      <LeadGenCapturePageClient />
    </Suspense>
  );
}
