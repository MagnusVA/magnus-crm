import { notFound } from "next/navigation";
import { fetchQuery, preloadQuery } from "@/lib/convex-server-reads";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";
import { isExpectedConvexRejection } from "@/lib/errors";
import { ContentReveal } from "@/components/page-transitions";
import { BillingUnavailable } from "../../_components/billing-unavailable";
import { WhopPaymentPageClient } from "../_components/whop-payment-page-client";

export const instant = false;

export default async function BillingWhopPaymentPage({
  params,
}: {
  params: Promise<{ providerPaymentId: string }>;
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

  const { providerPaymentId } = await params;
  const paymentId = providerPaymentId as Id<"providerPayments">;
  let preloadedPayment;
  try {
    preloadedPayment = await preloadQuery(
      api.payments.review.getProviderPayment,
      { providerPaymentId: paymentId },
      { token: access.session.accessToken },
    );
  } catch (error) {
    // A malformed id is a 404; an outage or bug reaches the error boundary.
    if (!isExpectedConvexRejection(error)) throw error;
    notFound();
  }

  return (
    <ContentReveal>
      <WhopPaymentPageClient preloadedPayment={preloadedPayment} providerPaymentId={paymentId} />
    </ContentReveal>
  );
}
