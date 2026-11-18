import { SkeletonExit } from "@/components/page-transitions";
import { WhopPaymentSkeleton } from "../_components/whop-payment-skeleton";

export default function BillingWhopPaymentLoading() {
  return (
    <SkeletonExit>
      <WhopPaymentSkeleton />
    </SkeletonExit>
  );
}
