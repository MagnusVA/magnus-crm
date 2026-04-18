"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import type { Doc } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { usePollingQuery } from "@/hooks/use-polling-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useRole } from "@/components/auth/role-context";
import { useRouter } from "next/navigation";
import { UnmatchedBanner } from "./unmatched-banner";
import { FeaturedMeetingCard } from "./featured-meeting-card";
import { RemindersSection } from "./reminders-section";
import { PipelineStrip } from "./pipeline-strip";
import { CloserEmptyState } from "./closer-empty-state";
import { CalendarSection } from "./calendar-section";
import type { ViewMode } from "./calendar-utils";

type NextMeetingData =
  | {
      meeting: Doc<"meetings">;
      opportunity: Doc<"opportunities"> | null | undefined;
      lead: Doc<"leads"> | null | undefined;
      eventTypeName: string | null;
    }
  | null;

export function CloserDashboardPageClient() {
  usePageTitle("My Dashboard");
  const router = useRouter();
  const { isAdmin } = useRole();

  // ── Shared filter state (calendar + pipeline strip) ───────────────────
  // Owned here so a single source of truth drives both the calendar query
  // and the stats query. Defaults match the calendar's previous defaults.
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [currentDate, setCurrentDate] = useState(() => new Date());

  const { startDate, endDate } = useMemo(() => {
    let start: Date;
    let end: Date;

    if (viewMode === "day") {
      start = startOfDay(currentDate);
      end = endOfDay(currentDate);
    } else if (viewMode === "week") {
      start = startOfWeek(currentDate); // Sunday
      end = endOfWeek(currentDate); // Saturday 23:59:59
    } else {
      // month — extend to fill calendar grid (prev/next month partials)
      start = startOfWeek(startOfMonth(currentDate));
      end = endOfWeek(endOfMonth(currentDate));
    }

    return { startDate: start.getTime(), endDate: end.getTime() };
  }, [currentDate, viewMode]);

  const rangeLabel = useMemo(() => {
    if (viewMode === "day") {
      return format(currentDate, "EEEE, MMMM d, yyyy");
    }
    if (viewMode === "week") {
      const ws = startOfWeek(currentDate);
      const we = endOfWeek(currentDate);
      return `${format(ws, "MMM d")} – ${format(we, "MMM d, yyyy")}`;
    }
    return format(currentDate, "MMMM yyyy");
  }, [currentDate, viewMode]);

  const profile = useQuery(
    api.closer.dashboard.getCloserProfile,
    isAdmin ? "skip" : {},
  );
  const pipelineSummary = useQuery(
    api.closer.dashboard.getPipelineSummary,
    isAdmin ? "skip" : { startDate, endDate },
  );

  const nextMeeting = usePollingQuery(
    api.closer.dashboard.getNextMeeting,
    isAdmin ? "skip" : {},
    { intervalMs: 60_000 },
  ) as NextMeetingData | undefined;

  useEffect(() => {
    if (isAdmin) {
      router.replace("/workspace");
    }
  }, [isAdmin, router]);

  if (
    isAdmin ||
    profile === undefined ||
    pipelineSummary === undefined ||
    nextMeeting === undefined
  ) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-pretty">
          My Dashboard
        </h1>
        <p className="text-sm text-muted-foreground">
          Welcome back, {profile.fullName ?? profile.email}
        </p>
      </div>

      {!profile.isCalendlyLinked && <UnmatchedBanner />}

      {/* Next meeting + reminders — side by side on desktop */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_minmax(0,400px)]">
        {nextMeeting ? (
          <FeaturedMeetingCard
            meeting={nextMeeting.meeting}
            lead={nextMeeting.lead ?? null}
            eventTypeName={nextMeeting.eventTypeName}
          />
        ) : (
          <CloserEmptyState
            title="No upcoming meetings"
            description="You don't have any scheduled meetings. New meetings will appear here automatically when leads book through Calendly."
          />
        )}

        {/* Reminders panel — only renders when closer has active reminders */}
        <RemindersSection />
      </div>

      <PipelineStrip
        counts={pipelineSummary.counts}
        total={pipelineSummary.total}
        rangeLabel={rangeLabel}
        viewMode={viewMode}
      />

      <Separator />

      <CalendarSection
        viewMode={viewMode}
        currentDate={currentDate}
        startDate={startDate}
        endDate={endDate}
        rangeLabel={rangeLabel}
        onViewModeChange={setViewMode}
        onCurrentDateChange={setCurrentDate}
      />
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>

      <Skeleton className="h-[180px] rounded-xl" />

      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px] rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
