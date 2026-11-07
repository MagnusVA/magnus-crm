import { MeetingDetailSkeleton } from "@/app/workspace/closer/meetings/_components/meeting-detail-skeleton";
import { SkeletonExit } from "@/components/page-transitions";

export default function AdminMeetingDetailLoading() {
	return (
		<SkeletonExit>
			<MeetingDetailSkeleton />
		</SkeletonExit>
	);
}
