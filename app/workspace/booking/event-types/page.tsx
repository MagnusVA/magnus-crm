import { Suspense } from "react";
import { EventTypesPageClient } from "./_components/event-types-page-client";
import { EventTypesPageSkeleton } from "./_components/event-types-page-skeleton";

export default function BookingEventTypesPage() {
  return (
    <Suspense fallback={<EventTypesPageSkeleton />}>
      <EventTypesPageClient />
    </Suspense>
  );
}
