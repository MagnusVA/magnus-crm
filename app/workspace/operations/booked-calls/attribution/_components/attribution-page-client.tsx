"use client";

import { useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { ArrowLeftIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePageTitle } from "@/hooks/use-page-title";
import { AttributionRegistry } from "./attribution-registry";
import { AttributionUnmappedPanel } from "./attribution-unmapped-panel";
import { BookingLinkMatrix } from "./booking-link-matrix";
import { CampaignPresetsCard } from "./campaign-presets-card";
import { PortalAccessCard } from "./portal-access-card";
import { PortalEventTypeReadinessCard } from "./portal-event-type-readiness-card";
import { PortalUsageCard } from "./portal-usage-card";

const SECTIONS = ["teams", "portal", "diagnostics"] as const;
type Section = (typeof SECTIONS)[number];

function sectionFromParam(value: string | null): Section {
  return SECTIONS.includes(value as Section) ? (value as Section) : "teams";
}

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
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-[3px] h-7 w-[3px] shrink-0 rounded-full bg-primary/75" />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              Attribution
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              DM teams, closers, the link portal, and attribution diagnostics
              behind booked calls.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/workspace/operations/booked-calls">
            <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
            Booked Calls
          </Link>
        </Button>
      </header>

      <Tabs value={section} onValueChange={handleSectionChange}>
        <TabsList>
          <TabsTrigger value="teams">Teams & DM Closers</TabsTrigger>
          <TabsTrigger value="portal">Link Portal</TabsTrigger>
          <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
        </TabsList>

        <TabsContent value="teams" className="mt-4">
          <AttributionRegistry />
        </TabsContent>

        <TabsContent value="portal" className="mt-4">
          <PortalSection />
        </TabsContent>

        <TabsContent value="diagnostics" className="mt-4">
          <DiagnosticsSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PortalSection() {
  const eventTypeConfigs = useQuery(
    api.eventTypeConfigs.queries.listEventTypeConfigs,
    {},
  );

  return (
    <div className="flex flex-col gap-4">
      <PortalAccessCard />
      <CampaignPresetsCard />
      {eventTypeConfigs === undefined ? (
        <Skeleton className="h-72 w-full" />
      ) : (
        <PortalEventTypeReadinessCard eventTypeConfigs={eventTypeConfigs} />
      )}
      <PortalUsageCard />
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
    <div className="flex flex-col gap-4">
      <AttributionUnmappedPanel />
      {matrixLoaded ? (
        <BookingLinkMatrix
          teams={teams}
          closers={closers}
          eventTypeConfigs={eventTypeConfigs}
        />
      ) : (
        <Skeleton className="h-80 w-full" />
      )}
    </div>
  );
}
