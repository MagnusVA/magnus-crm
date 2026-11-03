import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { BookingPageSkeleton } from "../_components/booking-page-skeleton";
import { PortalPageClient } from "../_components/portal-page-client";

export const unstable_instant = false;

export default async function BookingPortalPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<BookingPageSkeleton />}>
      <PortalPageClient />
    </Suspense>
  );
}
