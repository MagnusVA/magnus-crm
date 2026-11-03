"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle } from "@/hooks/use-page-title";
import { buildBoard } from "./booking-model";
import { CampaignPresetsCard } from "./campaign-presets-card";
import { CellPicker } from "./coverage/cell-picker";
import { CellTipProvider } from "./coverage/cell-tip";
import { CoverageProvider } from "./coverage/coverage-context";
import { CoverageMotionStyles } from "./coverage/coverage-motion";
import { PortalPreview } from "./coverage/portal-preview";
import { PortalAccessCard } from "./portal-access-card";
import { PortalUsageCard } from "./portal-usage-card";

const EMPTY_BOOKINGS: Record<string, number> = {};

/**
 * Link portal: concept C's three columns at full width (Access and Campaign
 * presets, Recent link copies, the live portal preview), folding to the
 * cards plus the preview, then to one column, as the container narrows.
 * The preview is the Coverage tab's, so both tabs show the same phone.
 */
export function PortalPageClient() {
  usePageTitle("Link portal · Booking setup");

  return (
    <div className="@container/portal min-w-0">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-3.5 @[52rem]/portal:grid-cols-[minmax(0,1fr)_286px] @[66rem]/portal:grid-cols-[minmax(0,1fr)_312px]">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-3.5 @[66rem]/portal:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-3.5">
            <PortalAccessCard />
            <CampaignPresetsCard />
          </div>
          <PortalUsageCard />
        </div>
        <PreviewColumn />
      </div>
    </div>
  );
}

/** The Coverage worker's live preview, fed the same coverage board. */
function PreviewColumn() {
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  const activity = useQuery(api.bookingSetup.queries.getBookingActivity, {});
  const closers = useQuery(api.attribution.dmClosers.listDmClosers, {});
  const board = useMemo(() => (coverage ? buildBoard(coverage) : null), [coverage]);

  if (!coverage || !board) {
    return (
      <div role="status" aria-label="Loading the live portal preview" className="flex flex-col gap-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="mx-auto h-[520px] w-[280px] rounded-[42px]" />
      </div>
    );
  }

  return (
    <CoverageProvider
      coverage={coverage}
      board={board}
      bookings={activity?.bookings30d.eventTypes ?? EMPTY_BOOKINGS}
      activityLoaded={activity !== undefined}
      closers={closers}
    >
      <CellTipProvider>
        <CoverageMotionStyles />
        <PortalPreview className="@[52rem]/portal:sticky @[52rem]/portal:top-3" />
        {/* "Missing: …" in the preview opens the cell picker here too. */}
        <CellPicker />
      </CellTipProvider>
    </CoverageProvider>
  );
}
