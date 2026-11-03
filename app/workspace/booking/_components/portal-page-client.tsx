"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { CampaignPresetsCard } from "./campaign-presets-card";
import { PortalAccessCard } from "./portal-access-card";
import { PortalUsageCard } from "./portal-usage-card";

export function PortalPageClient() {
  usePageTitle("Link portal");

  return (
    <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
      <div className="grid gap-3.5 short:gap-3 @5xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @5xl:items-start">
        <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
          <PortalAccessCard />
          <CampaignPresetsCard />
        </div>
        <PortalUsageCard />
      </div>
    </div>
  );
}
