import { SkeletonExit } from "@/components/page-transitions";
import { FathomPageSkeleton } from "./_components/fathom-page-skeleton";

export default function FathomSettingsLoading() {
  return (
    <SkeletonExit>
      <FathomPageSkeleton />
    </SkeletonExit>
  );
}
