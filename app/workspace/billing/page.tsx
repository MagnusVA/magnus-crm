import { Suspense } from "react";
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requirePermission } from "@/lib/auth";
import { BillingPageClient } from "./_components/billing-page-client";
import { BillingPageSkeleton } from "./_components/billing-page-skeleton";
import { BillingUnavailable } from "./_components/billing-unavailable";

export const unstable_instant = false;

export default async function BillingPage() {
  const access = await requirePermission("billing:view");
  const availability = await fetchQuery(
    api.billing.queries.getAvailability,
    {},
    { token: access.session.accessToken },
  );

  if (!availability.enabled) {
    return <BillingUnavailable reason={availability.reason} />;
  }

  return (
    <Suspense fallback={<BillingPageSkeleton />}>
      <BillingPageClient />
    </Suspense>
  );
}
