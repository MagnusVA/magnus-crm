"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { businessDateForInstant, businessDayRange } from "@/lib/businessDay";
import { usePageTitle } from "@/hooks/use-page-title";
import { useNow } from "@/hooks/use-now";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useRole } from "@/components/auth/role-context";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { nextCall } from "./board-status";
import { CloserTodaySkeleton } from "./closer-today-skeleton";
import { NeedsOutcomeCard } from "./needs-outcome-card";
import { PerformanceCard } from "./performance-card";
import { SectionError } from "./section-state";
import { TasksCard } from "./tasks-card";
import { TodayHeader } from "./today-header";
import { TodaysCallsBoard } from "./todays-calls-board";
import { UnmatchedBanner } from "./unmatched-banner";

/**
 * The closer's Today page: the calls board and performance on the left,
 * the calls still owed an outcome and today's tasks on the right. The page
 * is a container: narrower than 56rem (a half-screen window, a zoomed-in
 * browser) the columns stack in the order a closer works them: calls,
 * outcomes, tasks, then performance.
 */
export function CloserTodayPageClient() {
  usePageTitle("Today");
  const router = useRouter();
  const { isAdmin } = useRole();
  const now = useNow();
  const { setting, loaded } = useBusinessDay();

  const profile = useQuery(api.closer.dashboard.getCloserProfile, isAdmin ? "skip" : {});
  // Queries are bounded by the business day, so their arguments move once a
  // day and Convex keeps them live; which call is next, and which have
  // ended, is worked out here as `now` ticks.
  const businessDate = businessDateForInstant(now, setting);
  const today = useMemo(() => businessDayRange(businessDate, setting), [businessDate, setting]);
  const skip = isAdmin || !loaded;
  const todayCalls = useQuery(
    api.closer.calendar.getMeetingsForRange,
    skip ? "skip" : { startDate: today.start, endDate: today.end },
  );
  const afterToday = useQuery(api.closer.dashboard.getNextMeeting, skip ? "skip" : { from: today.end });
  const needsOutcome = useQuery(
    api.closer.dashboard.getMeetingsNeedingOutcome,
    skip ? "skip" : { before: today.end },
  );
  const next = nextCall(todayCalls?.meetings, afterToday, now);

  useEffect(() => {
    if (isAdmin) {
      router.replace("/workspace");
    }
  }, [isAdmin, router]);

  if (isAdmin || profile === undefined || !loaded) {
    return <CloserTodaySkeleton />;
  }

  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-4 pb-6 short:gap-3">
      <TodayHeader setting={setting} />

      {!profile.isCalendlyLinked && <UnmatchedBanner />}

      <div className="grid gap-x-5 gap-y-3.5 @4xl:grid-cols-[minmax(0,1fr)_20rem] @4xl:grid-rows-[auto_1fr] @6xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 @4xl:col-start-1 @4xl:row-start-1">
          <SectionErrorBoundary
            sectionName="today's calls"
            fallback={
              <div className="rounded-xl bg-board text-board-foreground">
                <SectionError what="your calls" />
              </div>
            }
          >
            <TodaysCallsBoard setting={setting} now={now} next={next} />
          </SectionErrorBoundary>
        </div>

        <div className="flex min-w-0 flex-col gap-3.5 @4xl:col-start-2 @4xl:row-span-2 @4xl:row-start-1">
          <SectionErrorBoundary
            sectionName="calls that need an outcome"
            fallback={
              <div className="rounded-xl border bg-card">
                <SectionError what="calls that need an outcome" />
              </div>
            }
          >
            <NeedsOutcomeCard result={needsOutcome} now={now} timeZone={setting.timeZone} />
          </SectionErrorBoundary>
          <SectionErrorBoundary
            sectionName="tasks"
            fallback={
              <div className="rounded-xl border bg-card">
                <SectionError what="your tasks" />
              </div>
            }
          >
            <TasksCard setting={setting} now={now} />
          </SectionErrorBoundary>
        </div>

        <div className="min-w-0 @4xl:col-start-1 @4xl:row-start-2 @4xl:self-start">
          <SectionErrorBoundary
            sectionName="performance"
            fallback={
              <div className="rounded-xl border bg-card">
                <SectionError what="your performance" />
              </div>
            }
          >
            <PerformanceCard setting={setting} now={now} />
          </SectionErrorBoundary>
        </div>
      </div>
    </div>
  );
}
