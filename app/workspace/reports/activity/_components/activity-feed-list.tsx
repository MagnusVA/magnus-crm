"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ActivityEventRow } from "./activity-event-row";

interface ActivityFeedListProps {
  events: Array<{
    _id: string;
    eventType: string;
    entityType: string;
    actorName: string | null;
    occurredAt: number;
    source: string;
    metadata: Record<string, unknown> | null;
  }>;
  onLoadMore: () => void;
  hasMore: boolean;
  isLoading: boolean;
}

export function ActivityFeedList({
  events,
  onLoadMore,
  hasMore,
  isLoading,
}: ActivityFeedListProps) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label="Loading activity events">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">
          No activity found for this period and filters.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {events.map((event) => (
        <ActivityEventRow key={event._id} event={event} />
      ))}
      {hasMore && (
        <div className="flex justify-center pt-4">
          <Button variant="outline" onClick={onLoadMore}>
            Load More
          </Button>
        </div>
      )}
    </div>
  );
}
