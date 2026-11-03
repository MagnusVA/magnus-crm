import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { BookingPageSkeleton } from "../_components/booking-page-skeleton";
import { TeamsPageClient } from "../_components/teams-page-client";

export const unstable_instant = false;

export default async function BookingTeamsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<BookingPageSkeleton />}>
      <TeamsPageClient />
    </Suspense>
  );
}
