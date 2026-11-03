import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { InboxPageClient } from "./_components/inbox-page-client";
import { InboxPageSkeleton } from "./_components/inbox-page-skeleton";

export const unstable_instant = false;

export default async function BookingInboxPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<InboxPageSkeleton />}>
      <InboxPageClient />
    </Suspense>
  );
}
