"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { SettingsIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LeadGenExportMenu } from "./lead-gen-export-menu";
import { LeadGenFilterBar } from "./lead-gen-filter-bar";
import { LeadGenSummaryCards } from "./lead-gen-summary-cards";
import { RawSubmissionsTable } from "./raw-submissions-table";
import { SourcePerformanceTable } from "./source-performance-table";
import { TeamPerformanceTable } from "./team-performance-table";
import { TopOriginsTable } from "./top-origins-table";
import { WorkerPerformanceTable } from "./worker-performance-table";

type LeadGenSource = "instagram" | "meta_business";

export type LeadGenFilters = {
  startDayKey: string;
  endDayKey: string;
  teamId?: Id<"attributionTeams">;
  workerId?: Id<"leadGenWorkers">;
  source?: LeadGenSource;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HONDURAS_TIME_ZONE = "America/Tegucigalpa";
const BUSINESS_DAY_START_OFFSET_MS = 60 * 60 * 1000;

function businessDayKey(timestamp: number) {
  const shifted = new Date(timestamp - BUSINESS_DAY_START_OFFSET_MS);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HONDURAS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

function addDays(dayKey: string, days: number) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day) + days * DAY_MS;
  return new Date(timestamp).toISOString().slice(0, 10);
}

const currentBusinessDayKey = businessDayKey(Date.now());

export function LeadGenAdminPageClient() {
  const defaultFilters = useMemo(() => {
    const endDayKey = currentBusinessDayKey;
    return {
      startDayKey: addDays(endDayKey, -6),
      endDayKey,
    };
  }, []);
  const [filters, setFilters] = useState<LeadGenFilters>(defaultFilters);

  const overview = useQuery(api.leadGen.reporting.getOverview, filters);
  const workers = useQuery(api.leadGen.workers.listWorkers, {
    includeInactive: true,
  });
  const teams = useQuery(api.leadGen.workers.listTeams, {
    includeInactive: true,
  });
  const workerRows = useQuery(
    api.leadGen.reporting.listWorkerPerformance,
    filters,
  );
  const teamRows = useQuery(api.leadGen.reporting.listTeamPerformance, filters);
  const sourceRows = useQuery(
    api.leadGen.reporting.listSourcePerformance,
    filters,
  );
  const origins = useQuery(api.leadGen.reporting.listTopOrigins, {
    startDayKey: filters.startDayKey,
    endDayKey: filters.endDayKey,
    ...(filters.source ? { source: filters.source } : {}),
    limit: 10,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="sticky top-0 z-20 -mx-6 -mt-6 border-b bg-background/95 px-6 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-normal text-pretty">
              Lead Gen Ops
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Worker activity, source quality, top origins, and operational
              exports.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild>
              <Link href="/workspace/lead-gen/settings">
                <SettingsIcon data-icon="inline-start" />
                Settings & Schedules
              </Link>
            </Button>
            <LeadGenExportMenu
              endDayKey={filters.endDayKey}
              source={filters.source}
              startDayKey={filters.startDayKey}
              teamId={filters.teamId}
              workerId={filters.workerId}
            />
          </div>
        </div>
      </div>

      <LeadGenFilterBar
        teams={teams}
        value={filters}
        workers={workers}
        onChange={setFilters}
      />

      <LeadGenSummaryCards data={overview} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
        <Tabs className="min-w-0" defaultValue="workers">
          <TabsList>
            <TabsTrigger value="workers">Workers</TabsTrigger>
            <TabsTrigger value="teams">Teams</TabsTrigger>
            <TabsTrigger value="sources">Sources</TabsTrigger>
          </TabsList>
          <TabsContent value="workers">
            <WorkerPerformanceTable rows={workerRows} workers={workers} />
          </TabsContent>
          <TabsContent value="teams">
            <TeamPerformanceTable rows={teamRows} />
          </TabsContent>
          <TabsContent value="sources">
            <SourcePerformanceTable rows={sourceRows} />
          </TabsContent>
        </Tabs>
        <TopOriginsTable rows={origins} />
      </div>

      <RawSubmissionsTable filters={filters} />
    </div>
  );
}
