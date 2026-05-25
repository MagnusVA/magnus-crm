import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { LeadGenSettingsPageClient } from "../_components/lead-gen-settings-page-client";
import { LeadGenSettingsSkeleton } from "../_components/lead-gen-settings-skeleton";

export const unstable_instant = false;

export default async function LeadGenSettingsPage() {
  await requirePermission("lead-gen:manage-workers");

  return (
    <Suspense fallback={<LeadGenSettingsSkeleton />}>
      <LeadGenSettingsPageClient />
    </Suspense>
  );
}
