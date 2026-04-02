"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { UnmatchedBanner } from "./_components/unmatched-banner";
import { FeaturedMeetingCard } from "./_components/featured-meeting-card";
import { PipelineStrip } from "./_components/pipeline-strip";
import { CloserEmptyState } from "./_components/closer-empty-state";
import { CalendarView } from "./_components/calendar-view";

/**
 * Closer Dashboard — `/workspace/closer`
 *
 * The closer's primary workspace surface, composed of four sections:
 *
 * 1. **Unmatched banner** (conditional) — warns when the closer has no
 *    linked Calendly member so meetings can't be attributed.
 * 2. **Featured meeting card** — the next scheduled meeting with countdown,
 *    lead info, and a Join Zoom CTA.
 * 3. **Pipeline strip** — compact stage‑count cards that link to the
 *    filtered pipeline page.
 * 4. **Calendar** — self‑contained week/day/month view of upcoming meetings.
 *
 * Each query is a separate Convex subscription so only the affected section
 * re‑renders when data changes (vercel-react-best-practices: rerender-memo).
 */
export default function CloserDashboardPage() {
  const profile = useQuery(api.closer.dashboard.getCloserProfile);
  const nextMeeting = useQuery(api.closer.dashboard.getNextMeeting);
  const pipelineSummary = useQuery(api.closer.dashboard.getPipelineSummary);

  // ── Loading state ───────────────────────────────────────────────────────
  if (
    profile === undefined ||
    nextMeeting === undefined ||
    pipelineSummary === undefined
  ) {
    return <DashboardSkeleton />;
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-pretty">My Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Welcome back, {profile.fullName ?? profile.email}
        </p>
      </div>

      {/* Unmatched closer warning */}
      {!profile.isCalendlyLinked && <UnmatchedBanner />}

      {/* Featured next meeting */}
      {nextMeeting ? (
        <FeaturedMeetingCard
          meeting={nextMeeting.meeting}
          lead={nextMeeting.lead}
          eventTypeName={nextMeeting.eventTypeName}
        />
      ) : (
        <CloserEmptyState
          title="No upcoming meetings"
          description="You don't have any scheduled meetings. New meetings will appear here automatically when leads book through Calendly."
        />
      )}

      {/* Pipeline summary strip */}
      <PipelineStrip
        counts={pipelineSummary.counts}
        total={pipelineSummary.total}
      />

      <Separator />

      {/* Calendar — manages its own query & state */}
      <div>
        <h2 className="mb-3 text-lg font-semibold tracking-tight text-pretty">
          My Schedule
        </h2>
        <CalendarView />
      </div>
    </div>
  );
}

// ─── Loading skeleton ────────────────────────────────────────────────────────

/**
 * Skeleton that mirrors the dashboard layout to prevent layout shift while
 * the three Convex subscriptions resolve.
 */
function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      {/* Greeting */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>

      {/* Featured card */}
      <Skeleton className="h-[180px] rounded-xl" />

      {/* Pipeline strip */}
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
