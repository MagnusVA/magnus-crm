import { Suspense } from "react";
import { BookingPageSkeleton } from "../_components/booking-page-skeleton";
import { TeamsPageClient } from "../_components/teams-page-client";

export default function BookingTeamsPage() {
  return (
    <Suspense fallback={<BookingPageSkeleton />}>
      <TeamsPageClient />
    </Suspense>
  );
}
