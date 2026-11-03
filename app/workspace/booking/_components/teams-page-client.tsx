"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { AttributionRegistry } from "./attribution-registry";
import { AttributionUnmappedPanel } from "./attribution-unmapped-panel";

export function TeamsPageClient() {
  usePageTitle("DM teams");

  return (
    <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
      <AttributionRegistry />
      <AttributionUnmappedPanel />
    </div>
  );
}
