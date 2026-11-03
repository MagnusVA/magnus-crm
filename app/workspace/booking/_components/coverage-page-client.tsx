"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle } from "@/hooks/use-page-title";
import { buildBoard } from "./booking-model";
import { CellPicker } from "./coverage/cell-picker";
import { CellTipProvider } from "./coverage/cell-tip";
import { CoverageProvider } from "./coverage/coverage-context";
import { CoverageMatrix } from "./coverage/coverage-matrix";
import { CoverageMotionStyles } from "./coverage/coverage-motion";
import { ProgramSheet, TeamSheet } from "./coverage/coverage-sheets";
import { PortalPreview } from "./coverage/portal-preview";

const EMPTY_BOOKINGS: Record<string, number> = {};

/**
 * Coverage: concept C's matrix of programs against DM teams, with the live
 * portal preview beside it. Cells change live with Undo; the picker, the
 * program and team sheets and the previewed DM closer live in the URL
 * (`?cell=`, `?program=`, `?team=`, `?closer=`, `?show=problems`).
 */
export function CoveragePageClient() {
  usePageTitle("Coverage · Booking setup");
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  const activity = useQuery(api.bookingSetup.queries.getBookingActivity, {});
  const closers = useQuery(api.attribution.dmClosers.listDmClosers, {});
  const board = useMemo(() => (coverage ? buildBoard(coverage) : null), [coverage]);
  const [previewOpen, setPreviewOpen] = useState(false);

  if (!coverage || !board) return <CoverageSkeleton />;

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
        <div className="@container/coverage min-w-0">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-3.5 @[62rem]/coverage:grid-cols-[minmax(0,1fr)_286px] @[76rem]/coverage:grid-cols-[minmax(0,1fr)_312px]">
            <CoverageMatrix onOpenPreview={() => setPreviewOpen(true)} />
            <PortalPreview className="sticky top-3 hidden @[62rem]/coverage:flex" />
          </div>
        </div>

        <Sheet open={previewOpen} onOpenChange={setPreviewOpen}>
          <SheetContent className="w-[min(360px,100vw)] gap-0 bg-background p-4 pt-10 data-[side=right]:sm:max-w-[360px]">
            <SheetTitle className="sr-only">Live portal preview</SheetTitle>
            <SheetDescription className="sr-only">The DM link portal as one DM closer gets it now.</SheetDescription>
            <PortalPreview />
          </SheetContent>
        </Sheet>

        <CellPicker />
        <ProgramSheet />
        <TeamSheet />
      </CellTipProvider>
    </CoverageProvider>
  );
}

export function CoverageSkeleton() {
  return (
    <div role="status" aria-label="Loading coverage" className="@container/coverage min-w-0">
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-3.5 @[62rem]/coverage:grid-cols-[minmax(0,1fr)_286px] @[76rem]/coverage:grid-cols-[minmax(0,1fr)_312px]">
        <div className="overflow-hidden rounded-[10px] border border-border bg-card">
          <div className="flex h-11 items-center gap-3 border-b border-border px-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-3.5 w-72" />
          </div>
          <div className="h-[30px] border-b border-border bg-background" />
          <div className="h-[78px] border-b border-border" />
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex h-[51px] items-center gap-4 border-b border-border px-3 last:border-b-0">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 flex-1" />
            </div>
          ))}
        </div>
        <div className="hidden flex-col gap-2 @[62rem]/coverage:flex">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="mx-auto h-[520px] w-[280px] rounded-[42px]" />
        </div>
      </div>
    </div>
  );
}
