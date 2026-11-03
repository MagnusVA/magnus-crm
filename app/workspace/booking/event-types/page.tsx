import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { EventTypesPageClient } from "./_components/event-types-page-client";
import { EventTypesPageSkeleton } from "./_components/event-types-page-skeleton";

export const unstable_instant = false;

export default async function BookingEventTypesPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<EventTypesPageSkeleton />}>
      <EventTypesPageClient />
    </Suspense>
  );
}
