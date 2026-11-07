import { MeetingDetailSkeleton } from "../_components/meeting-detail-skeleton";
import { SkeletonExit } from "@/components/page-transitions";

export default function MeetingDetailLoading() {
	return (
		<SkeletonExit>
			<MeetingDetailSkeleton />
		</SkeletonExit>
	);
}
