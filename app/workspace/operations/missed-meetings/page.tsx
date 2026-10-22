import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { MissedMeetingsPageClient } from "./_components/missed-meetings-page-client";
import { MissedMeetingsPageSkeleton } from "./_components/missed-meetings-page-skeleton";

export const unstable_instant = false;

export default async function OperationsMissedMeetingsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<MissedMeetingsPageSkeleton />}>
      <MissedMeetingsPageClient />
    </Suspense>
  );
}
