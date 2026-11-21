import { SkeletonExit } from "@/components/page-transitions";
import { WhopPageSkeleton } from "./_components/whop-page-skeleton";

export default function WhopSettingsLoading() {
  return (
    <SkeletonExit>
      <WhopPageSkeleton />
    </SkeletonExit>
  );
}
