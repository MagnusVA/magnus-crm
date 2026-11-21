import { SkeletonExit } from "@/components/page-transitions";
import { AutomaticResultsSkeleton } from "./_components/automatic-results-skeleton";

export default function AutomaticResultsLoading() {
  return (
    <SkeletonExit>
      <AutomaticResultsSkeleton />
    </SkeletonExit>
  );
}
