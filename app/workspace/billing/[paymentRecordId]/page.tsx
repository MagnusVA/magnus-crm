import { fetchQuery, preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";
import { BillingReviewPageClient } from "../_components/billing-review-page-client";
import { BillingUnavailable } from "../_components/billing-unavailable";

export const unstable_instant = false;

export default async function BillingPaymentPage({
  params,
}: {
  params: Promise<{ paymentRecordId: string }>;
}) {
  const access = await requirePermission("billing:view");
  const availability = await fetchQuery(
    api.billing.queries.getAvailability,
    {},
    { token: access.session.accessToken },
  );

  if (!availability.enabled) {
    return <BillingUnavailable reason={availability.reason} />;
  }

  const { paymentRecordId } = await params;
  const preloadedPayment = await preloadQuery(
    api.billing.queries.getPaymentDetail,
    { paymentRecordId: paymentRecordId as Id<"paymentRecords"> },
    { token: access.session.accessToken },
  );

  return <BillingReviewPageClient preloadedPayment={preloadedPayment} />;
}
