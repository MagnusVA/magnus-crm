"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { useNow } from "@/hooks/use-now";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useRole } from "@/components/auth/role-context";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { CloserTodaySkeleton } from "./closer-today-skeleton";
import { NeedsOutcomeCard } from "./needs-outcome-card";
import { PerformanceCard } from "./performance-card";
import { SectionError } from "./section-state";
import { TasksCard } from "./tasks-card";
import { TodayHeader } from "./today-header";
import { TodaysCallsBoard } from "./todays-calls-board";
import { UnmatchedBanner } from "./unmatched-banner";
import { usePolledQuery } from "./use-polled-query";

/**
 * The closer's Today page: the calls board and performance on the left,
 * the calls still owed an outcome and today's tasks on the right. Below xl
 * the columns stack in the order a closer works them: calls, outcomes,
 * tasks, then performance.
 */
export function CloserTodayPageClient() {
  usePageTitle("Today");
  const router = useRouter();
  const { isAdmin } = useRole();
  const now = useNow();
  const { setting, loaded } = useBusinessDay();

  const profile = useQuery(api.closer.dashboard.getCloserProfile, isAdmin ? "skip" : {});
  // Both read the clock on the server, so they're fetched each minute.
  const nextMeeting = usePolledQuery(api.closer.dashboard.getNextMeeting, isAdmin ? "skip" : {});
  const needsOutcome = usePolledQuery(
    api.closer.dashboard.getMeetingsNeedingOutcome,
    isAdmin ? "skip" : {},
  );

  useEffect(() => {
    if (isAdmin) {
      router.replace("/workspace");
    }
  }, [isAdmin, router]);

  if (isAdmin || profile === undefined || !loaded) {
    return <CloserTodaySkeleton />;
  }

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 pb-6">
      <TodayHeader setting={setting} />

      {!profile.isCalendlyLinked && <UnmatchedBanner />}

      <div className="grid gap-x-5 gap-y-3.5 xl:grid-cols-[minmax(0,1fr)_384px] xl:grid-rows-[auto_1fr]">
        <div className="min-w-0 xl:col-start-1 xl:row-start-1">
          <SectionErrorBoundary
            sectionName="today's calls"
            fallback={
              <div className="rounded-xl bg-board text-board-foreground">
                <SectionError what="your calls" />
              </div>
            }
          >
            <TodaysCallsBoard setting={setting} now={now} nextMeeting={nextMeeting} />
          </SectionErrorBoundary>
        </div>

        <div className="flex min-w-0 flex-col gap-3.5 xl:col-start-2 xl:row-span-2 xl:row-start-1">
          <NeedsOutcomeCard result={needsOutcome} timeZone={setting.timeZone} />
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

        <div className="min-w-0 xl:col-start-1 xl:row-start-2 xl:self-start">
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
