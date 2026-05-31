import { Skeleton } from "@/components/ui/skeleton";

export function OpportunitySheetBodySkeleton() {
	return (
		<div
			className="flex flex-col gap-4 p-4"
			role="status"
			aria-label="Loading opportunity detail"
		>
			<Skeleton className="h-24 w-full skeleton-shimmer" />
			<Skeleton className="h-36 w-full skeleton-shimmer" />
			<Skeleton className="h-36 w-full skeleton-shimmer" />
			<Skeleton className="h-28 w-full skeleton-shimmer" />
		</div>
	);
}
