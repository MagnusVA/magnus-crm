import { SkeletonExit } from "@/components/page-transitions";
import { SettingsPageSkeleton } from "./_components/settings-skeleton";

export default function SettingsLoading() {
  return (
    <SkeletonExit>
      <SettingsPageSkeleton />
    </SkeletonExit>
  );
}
