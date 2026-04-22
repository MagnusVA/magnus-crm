"use client";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ActivityEventRow } from "./activity-event-row";

interface PaymentMetadata {
  programId: string | null;
  programName: string | null;
  paymentType: string;
  commissionable: boolean;
  attributedCloserId: string | null;
  originCategory: string;
}

interface ActivityFeedListProps {
  events: Array<{
    _id: string;
    eventType: string;
    entityType: string;
    actorName: string | null;
    occurredAt: number;
    source: string;
    metadata: Record<string, unknown> | null;
    paymentMetadata?: PaymentMetadata | null;
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
      <Empty className="rounded-lg border p-12">
        <EmptyHeader>
          <EmptyTitle>No activity found</EmptyTitle>
          <EmptyDescription>
            No activity matched the selected date range and filters.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-2">
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
