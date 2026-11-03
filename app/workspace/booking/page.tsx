import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { CoveragePageClient } from "./_components/coverage-page-client";
import { BookingPageSkeleton } from "./_components/booking-page-skeleton";

export const unstable_instant = false;

export default async function BookingCoveragePage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<BookingPageSkeleton />}>
      <CoveragePageClient />
    </Suspense>
  );
}
