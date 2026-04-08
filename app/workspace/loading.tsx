import { Skeleton } from "@/components/ui/skeleton";
import { StatsRowSkeleton } from "./_components/skeletons/stats-row-skeleton";
import { PipelineSummarySkeleton } from "./_components/skeletons/pipeline-summary-skeleton";
import { SystemHealthSkeleton } from "./_components/skeletons/system-health-skeleton";

export default function WorkspaceDashboardLoading() {
	return (
		<div
			className="flex flex-col gap-6"
			role="status"
			aria-label="Loading dashboard"
		>
			{/* Page header */}
			<div className="flex flex-col gap-2">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-4 w-96" />
			</div>

			<StatsRowSkeleton />
			<PipelineSummarySkeleton />
			<SystemHealthSkeleton />
		</div>
	);
}
