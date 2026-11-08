import { SkeletonExit } from "@/components/page-transitions";
import { EntityDetailSkeleton } from "./_components/entity-detail-skeleton";

export default function Loading() {
	return (
		<SkeletonExit>
			<EntityDetailSkeleton />
		</SkeletonExit>
	);
}
