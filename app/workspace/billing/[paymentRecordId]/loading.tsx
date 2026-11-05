import { BillingPageSkeleton } from "../_components/billing-page-skeleton";
import { SkeletonExit } from "@/components/page-transitions";

export default function BillingPaymentLoading() {
  return (
    <SkeletonExit>
      <BillingPageSkeleton detail />
    </SkeletonExit>
  );
}
