"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { usePollingQuery } from "@/hooks/use-polling-query";
import { useRole } from "@/components/auth/role-context";
import { CloserDashboardSkeleton } from "./closer-dashboard-skeleton";
import { useRouter } from "next/navigation";
import {
  DashboardDateRangeFilter,
  type DashboardRangeInput,
} from "@/app/workspace/_components/dashboard-date-range-filter";
import {
  businessDateToCalendarDate,
  validateCustomDashboardRange,
} from "@/app/workspace/_components/dashboard-date-utils";
import { UnmatchedBanner } from "./unmatched-banner";
import { FeaturedMeetingCard } from "./featured-meeting-card";
import { RemindersSection } from "./reminders-section";
import { PipelineStrip } from "./pipeline-strip";
import { CloserEmptyState } from "./closer-empty-state";
import { CalendarSection } from "./calendar-section";
import type { ViewMode } from "./calendar-utils";

type DerivedStatsRange = {
  startDate: number;
  endDate: number;
  label: string;
  periodNoun: string;
};

function formatRangeLabel(start: Date, end: Date): string {
  if (isSameDay(start, end)) {
    return format(start, "MMM d, yyyy");
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${format(start, "MMM d")} - ${format(end, "MMM d, yyyy")}`;
  }
  return `${format(start, "MMM d, yyyy")} - ${format(end, "MMM d, yyyy")}`;
}

function deriveStatsRange(range: DashboardRangeInput): DerivedStatsRange {
  const now = new Date();
  let start: Date;
  let end: Date;
  let periodNoun: string;

  if (range.kind === "custom") {
    start = startOfDay(businessDateToCalendarDate(range.startBusinessDate));
    end = endOfDay(
      businessDateToCalendarDate(range.endBusinessDateInclusive),
    );
    periodNoun = "selected range";
  } else if (range.preset === "today") {
    start = startOfDay(now);
    end = endOfDay(now);
    periodNoun = "today";
  } else if (range.preset === "this_week") {
    start = startOfWeek(now, { weekStartsOn: 1 });
    end = endOfWeek(now, { weekStartsOn: 1 });
    periodNoun = "this week";
  } else {
    start = startOfMonth(now);
    end = endOfMonth(now);
    periodNoun = "this month";
  }

  return {
    startDate: start.getTime(),
    endDate: end.getTime() + 1,
    label: formatRangeLabel(start, end),
    periodNoun,
  };
}

export function CloserDashboardPageClient() {
  usePageTitle("My Dashboard");
  const router = useRouter();
  const { isAdmin } = useRole();

  // ── Performance period filter ──────────────────────────────────────────
  // Matches the overview dashboard control, but stays independent from the
  // schedule calendar so closers can inspect a week while reviewing month stats.
  // Defaults to "this week": a single day usually reads as empty for a closer,
  // and it lines up with the calendar's default week view.
  const [statsRange, setStatsRange] = useState<DashboardRangeInput>({
    kind: "preset",
    preset: "this_week",
  });
  const [queryStatsRange, setQueryStatsRange] = useState<DashboardRangeInput>({
    kind: "preset",
    preset: "this_week",
  });

  const statsRangeValidationMessage =
    statsRange.kind === "custom"
      ? validateCustomDashboardRange({
          startBusinessDate: statsRange.startBusinessDate,
          endBusinessDateInclusive: statsRange.endBusinessDateInclusive,
        })
      : null;

  const statsWindow = useMemo(
    () => deriveStatsRange(queryStatsRange),
    [queryStatsRange],
  );

  // ── Schedule calendar state ────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [currentDate, setCurrentDate] = useState(() => new Date());

  const { scheduleStartDate, scheduleEndDate } = useMemo(() => {
    let start: Date;
    let end: Date;

    if (viewMode === "day") {
      start = startOfDay(currentDate);
      end = endOfDay(currentDate);
    } else if (viewMode === "week") {
      start = startOfWeek(currentDate, { weekStartsOn: 1 }); // Monday
      end = endOfWeek(currentDate, { weekStartsOn: 1 }); // Sunday 23:59:59
    } else {
      // month — extend to fill calendar grid (prev/next month partials)
      start = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 });
      end = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 });
    }

    return {
      scheduleStartDate: start.getTime(),
      scheduleEndDate: end.getTime() + 1,
    };
  }, [currentDate, viewMode]);

  const scheduleRangeLabel = useMemo(() => {
    if (viewMode === "day") {
      return format(currentDate, "EEEE, MMMM d, yyyy");
    }
    if (viewMode === "week") {
      const ws = startOfWeek(currentDate, { weekStartsOn: 1 });
      const we = endOfWeek(currentDate, { weekStartsOn: 1 });
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
    isAdmin
      ? "skip"
      : { startDate: statsWindow.startDate, endDate: statsWindow.endDate },
  );

  const nextMeeting = usePollingQuery(
    api.closer.dashboard.getNextMeeting,
    isAdmin ? "skip" : {},
    { intervalMs: 60_000 },
  );

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
    return <CloserDashboardSkeleton />;
  }

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 pb-6">
      <header className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-[3px] h-7 w-[3px] shrink-0 rounded-full bg-primary/75" />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-pretty">
              My Dashboard
            </h1>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              Welcome back, {profile.fullName ?? profile.email}
            </p>
          </div>
        </div>
        <DashboardDateRangeFilter
          browser
          value={statsRange}
          onChange={(nextRange) => {
            setStatsRange(nextRange);
            if (
              nextRange.kind === "preset" ||
              validateCustomDashboardRange({
                startBusinessDate: nextRange.startBusinessDate,
                endBusinessDateInclusive:
                  nextRange.endBusinessDateInclusive,
              }) === null
            ) {
              setQueryStatsRange(nextRange);
            }
          }}
          validationMessage={statsRangeValidationMessage}
        />
      </header>

      {!profile.isCalendlyLinked && <UnmatchedBanner />}

      {/* Upcoming meeting + reminders. Auto-fit so that when there are no
          reminders the meeting card reflows to fill the full width instead of
          leaving a gap, and the pair stacks cleanly in split-view widths. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-3">
        {nextMeeting?.meeting ? (
          <FeaturedMeetingCard
            meeting={nextMeeting.meeting}
            lead={nextMeeting.lead ?? null}
            eventTypeName={nextMeeting.eventTypeName}
          />
        ) : nextMeeting?.incomplete ? (
          <div role="status" aria-live="polite">
            <CloserEmptyState
              title="Upcoming meeting lookup incomplete"
              description="Check your calendar for upcoming meetings."
            />
          </div>
        ) : (
          <CloserEmptyState
            title="No upcoming meetings"
            description="New meetings appear here automatically when leads book through Calendly."
          />
        )}

        <RemindersSection />
      </div>

      <PipelineStrip
        counts={pipelineSummary.counts}
        total={pipelineSummary.total}
        decided={pipelineSummary.decided}
        rangeLabel={statsWindow.label}
        periodNoun={statsWindow.periodNoun}
        cashCollectedMinor={pipelineSummary.cashCollectedMinor}
        cashPaymentCount={pipelineSummary.cashPaymentCount}
        isPaymentDataTruncated={pipelineSummary.isPaymentDataTruncated}
        isMeetingDataTruncated={
          "isMeetingDataTruncated" in pipelineSummary && pipelineSummary.isMeetingDataTruncated
        }
      />

      <CalendarSection
        viewMode={viewMode}
        currentDate={currentDate}
        startDate={scheduleStartDate}
        endDate={scheduleEndDate}
        rangeLabel={scheduleRangeLabel}
        onViewModeChange={setViewMode}
        onCurrentDateChange={setCurrentDate}
      />
    </div>
  );
}

