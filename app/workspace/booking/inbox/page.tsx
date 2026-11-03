import { Suspense } from "react";
import { InboxPageClient } from "./_components/inbox-page-client";
import { InboxPageSkeleton } from "./_components/inbox-page-skeleton";

export default function BookingInboxPage() {
  return (
    <Suspense fallback={<InboxPageSkeleton />}>
      <InboxPageClient />
    </Suspense>
  );
}
