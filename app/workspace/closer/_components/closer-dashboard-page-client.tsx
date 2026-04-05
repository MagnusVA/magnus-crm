"use client";

import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import type { Doc } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { usePollingQuery } from "@/hooks/use-polling-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { UnmatchedBanner } from "./unmatched-banner";
import { FeaturedMeetingCard } from "./featured-meeting-card";
import { PipelineStrip } from "./pipeline-strip";
import { CloserEmptyState } from "./closer-empty-state";
import { CalendarView } from "./calendar-view";

type NextMeetingData =
  | {
      meeting: Doc<"meetings">;
      opportunity: Doc<"opportunities"> | null | undefined;
      lead: Doc<"leads"> | null | undefined;
      eventTypeName: string | null;
    }
  | null;

type CloserDashboardPageClientProps = {
  preloadedProfile: Preloaded<typeof api.closer.dashboard.getCloserProfile>;
  preloadedPipelineSummary: Preloaded<
    typeof api.closer.dashboard.getPipelineSummary
  >;
};

export function CloserDashboardPageClient({
  preloadedProfile,
  preloadedPipelineSummary,
}: CloserDashboardPageClientProps) {
  usePageTitle("My Dashboard");

  const profile = usePreloadedQuery(preloadedProfile);
  const pipelineSummary = usePreloadedQuery(preloadedPipelineSummary);

  const nextMeeting = usePollingQuery(
    api.closer.dashboard.getNextMeeting,
    {},
    { intervalMs: 60_000 },
  ) as NextMeetingData | undefined;

  if (nextMeeting === undefined) {
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

      <PipelineStrip
        counts={pipelineSummary.counts}
        total={pipelineSummary.total}
      />

      <Separator />

      <div>
        <h2 className="mb-3 text-lg font-semibold tracking-tight text-pretty">
          My Schedule
        </h2>
        <CalendarView />
      </div>
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
