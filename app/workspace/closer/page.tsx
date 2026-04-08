import { Suspense } from "react";
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import { CloserDashboardHeader } from "./_components/closer-dashboard-header";
import { FeaturedMeetingSection } from "./_components/featured-meeting-section";
import { PipelineStripSection } from "./_components/pipeline-strip-section";
import { CalendarSection } from "./_components/calendar-section";
import { SectionErrorBoundary } from "../_components/section-error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";

export const unstable_instant = { prefetch: "static" };

export default async function CloserDashboardPage() {
  const { session } = await requireRole(["closer"]);

  // Start all preloads in parallel — no sequential waterfall
  const [preloadedProfile, preloadedPipelineSummary] = await Promise.all([
    preloadQuery(
      api.closer.dashboard.getCloserProfile,
      {},
      { token: session.accessToken },
    ),
    preloadQuery(
      api.closer.dashboard.getPipelineSummary,
      {},
      { token: session.accessToken },
    ),
  ]);

  return (
    <div className="flex flex-col gap-6">
      {/* Header streams in with profile data + shows UnmatchedBanner if needed */}
      <SectionErrorBoundary sectionName="dashboard header">
        <Suspense fallback={<Skeleton className="h-14 w-64" />}>
          <CloserDashboardHeader preloadedProfile={preloadedProfile} />
        </Suspense>
      </SectionErrorBoundary>

      {/* Featured meeting — fetched independently via its own preloadQuery */}
      <SectionErrorBoundary sectionName="featured meeting">
        <Suspense fallback={<Skeleton className="h-[180px] rounded-xl" />}>
          <FeaturedMeetingSection token={session.accessToken} />
        </Suspense>
      </SectionErrorBoundary>

      {/* Pipeline strip */}
      <SectionErrorBoundary sectionName="pipeline">
        <Suspense
          fallback={
            <div className="flex flex-col gap-3">
              <Skeleton className="h-4 w-24" />
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
                {Array.from({ length: 7 }).map((_, i) => (
                  <Skeleton key={i} className="h-[76px] rounded-lg" />
                ))}
              </div>
            </div>
          }
        >
          <PipelineStripSection
            preloadedPipelineSummary={preloadedPipelineSummary}
          />
        </Suspense>
      </SectionErrorBoundary>

      <Separator />

      {/* Calendar — heaviest section, streams last */}
      <SectionErrorBoundary sectionName="calendar">
        <Suspense fallback={<Skeleton className="h-[400px] rounded-xl" />}>
          <CalendarSection />
        </Suspense>
      </SectionErrorBoundary>
    </div>
  );
}
