"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { EventTypeConfigList } from "./event-type-config-list";

export function EventTypesTab() {
  const configs = useQuery(
    api.eventTypeConfigs.queries.getEventTypeConfigsWithStats,
    {},
  );

  if (configs === undefined) {
    return (
      <div
        className="flex flex-col gap-4"
        role="status"
        aria-label="Loading event types"
      >
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return <EventTypeConfigList configs={configs} />;
}
