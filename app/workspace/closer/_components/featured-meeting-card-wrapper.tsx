"use client";

import { usePreloadedQuery } from "convex/react";
import type { Preloaded } from "convex/react";
import type { api } from "@/convex/_generated/api";
import { FeaturedMeetingCard } from "./featured-meeting-card";
import { CloserEmptyState } from "./closer-empty-state";

/**
 * Client wrapper that unwraps preloaded meeting and renders the card or empty state.
 */
export function FeaturedMeetingCardWrapper({
  preloadedMeeting,
}: {
  preloadedMeeting: Preloaded<typeof api.closer.dashboard.getNextMeeting>;
}) {
  const nextMeeting = usePreloadedQuery(preloadedMeeting);

  if (!nextMeeting) {
    return (
      <CloserEmptyState
        title="No upcoming meetings"
        description="You don't have any scheduled meetings. New meetings will appear here automatically when leads book through Calendly."
      />
    );
  }

  return (
    <FeaturedMeetingCard
      meeting={nextMeeting.meeting}
      lead={nextMeeting.lead ?? null}
      eventTypeName={nextMeeting.eventTypeName}
    />
  );
}
