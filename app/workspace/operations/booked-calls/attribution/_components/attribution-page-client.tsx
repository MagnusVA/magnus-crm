"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { api } from "@/convex/_generated/api";
import { PageBand } from "@/app/workspace/_components/page-band";
import { usePageTitle } from "@/hooks/use-page-title";
import { PipelineRecoveryPanel } from "../../../_components/pipeline-recovery-panel";
import { AttributionRegistry } from "./attribution-registry";
import { AttributionUnmappedPanel } from "./attribution-unmapped-panel";
import { BookingLinkMatrix, BookingLinkMatrixSkeleton } from "./booking-link-matrix";
import { CampaignPresetsCard } from "./campaign-presets-card";
import { PortalAccessCard } from "./portal-access-card";
import { PortalEventTypeReadinessCard, PortalEventTypeReadinessSkeleton } from "./portal-event-type-readiness-card";
import { PortalUsageCard } from "./portal-usage-card";
import { TeamEventTypesCard, TeamEventTypesSkeleton } from "./team-event-types-card";
import {
  ATTRIBUTION_BACK,
  ATTRIBUTION_DESCRIPTION,
  ATTRIBUTION_ROOT,
  ATTRIBUTION_TITLE,
  BAND_TAB_LIST,
  BAND_TAB_ROW,
  SECTION_LABEL,
  SECTIONS,
  type Section,
} from "./attribution-layout";

function sectionFromParam(value: string | null): Section {
  return SECTIONS.includes(value as Section) ? (value as Section) : "teams";
}

/** In-band tabs: the directory band's style (DESIGN.md, The directory band). */
const TAB =
  "h-10 shrink-0 border-b-2 border-transparent font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap text-board-muted uppercase outline-none hover:text-board-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[state=active]:border-primary data-[state=active]:text-board-foreground";

export function AttributionPageClient() {
  usePageTitle("Attribution");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const section = sectionFromParam(searchParams.get("section"));

  const handleSectionChange = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "teams") {
        params.delete("section");
      } else {
        params.set("section", next);
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  return (
    <TabsPrimitive.Root value={section} onValueChange={handleSectionChange} className={ATTRIBUTION_ROOT}>
      <PageBand title={ATTRIBUTION_TITLE} description={ATTRIBUTION_DESCRIPTION} back={ATTRIBUTION_BACK}>
        <div className={BAND_TAB_ROW}>
          <TabsPrimitive.List
            aria-label="Attribution sections"
            className={BAND_TAB_LIST}
          >
            {SECTIONS.map((value) => (
              <TabsPrimitive.Trigger key={value} value={value} className={TAB}>
                {SECTION_LABEL[value]}
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>
        </div>
      </PageBand>

      <TabsPrimitive.Content value="teams" className="min-w-0 outline-none">
        <AttributionRegistry />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="portal" className="min-w-0 outline-none">
        <PortalSection />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="diagnostics" className="flex min-w-0 flex-col gap-3.5 outline-none short:gap-3">
        <PipelineRecoveryPanel />
        <DiagnosticsSection />
      </TabsPrimitive.Content>
    </TabsPrimitive.Root>
  );
}

function PortalSection() {
  const eventTypeConfigs = useQuery(
    api.eventTypeConfigs.queries.listEventTypeConfigs,
    {},
  );

  // Settings sit in a 400px rail on the right from @6xl so the event type
  // tables get the main column; narrower, the rail stacks on top.
  return (
    <div className="grid gap-3.5 short:gap-3 @6xl:grid-cols-[minmax(0,1fr)_400px] @6xl:items-start">
      <div className="flex min-w-0 flex-col gap-3.5 short:gap-3 @6xl:col-start-2 @6xl:row-start-1">
        <PortalAccessCard />
        <CampaignPresetsCard />
        <PortalUsageCard />
      </div>
      <div className="flex min-w-0 flex-col gap-3.5 short:gap-3 @6xl:col-start-1 @6xl:row-start-1">
        {eventTypeConfigs === undefined ? (
          <>
            <PortalEventTypeReadinessSkeleton />
            <TeamEventTypesSkeleton />
          </>
        ) : (
          <>
            <PortalEventTypeReadinessCard eventTypeConfigs={eventTypeConfigs} />
            <TeamEventTypesCard eventTypeConfigs={eventTypeConfigs} />
          </>
        )}
      </div>
    </div>
  );
}

function DiagnosticsSection() {
  const teams = useQuery(api.attribution.teams.listTeams, {});
  const closers = useQuery(api.attribution.dmClosers.listDmClosers, {});
  const eventTypeConfigs = useQuery(
    api.eventTypeConfigs.queries.listEventTypeConfigs,
    {},
  );
  const matrixLoaded =
    teams !== undefined &&
    closers !== undefined &&
    eventTypeConfigs !== undefined;

  return (
    <>
      <AttributionUnmappedPanel />
      {matrixLoaded ? (
        <BookingLinkMatrix
          teams={teams}
          closers={closers}
          eventTypeConfigs={eventTypeConfigs}
        />
      ) : (
        <BookingLinkMatrixSkeleton />
      )}
    </>
  );
}
