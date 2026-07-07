import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { BookedCallsPageClient } from "./_components/booked-calls-page-client";
import { BookedCallsPageSkeleton } from "./_components/booked-calls-page-skeleton";

export const unstable_instant = false;

export default async function OperationsBookedCallsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<BookedCallsPageSkeleton />}>
      <BookedCallsPageClient />
    </Suspense>
  );
}
