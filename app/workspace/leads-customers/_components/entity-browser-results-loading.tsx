import { Skeleton } from "@/components/ui/skeleton";

export function ResultsLoading() {
	return (
		<div
			role="status"
			aria-label="Loading entity results"
			className="rounded-md border"
		>
			{Array.from({ length: 6 }).map((_, index) => (
				<div
					key={index}
					className="grid grid-cols-[minmax(0,1.6fr)_8rem_minmax(0,1fr)_8rem] gap-4 border-b p-3 last:border-b-0"
				>
					<Skeleton className="h-5 min-w-0 skeleton-shimmer" />
					<Skeleton className="h-5 w-20 skeleton-shimmer" />
					<Skeleton className="h-5 min-w-0 skeleton-shimmer" />
					<Skeleton className="h-5 w-24 justify-self-end skeleton-shimmer" />
				</div>
			))}
		</div>
	);
}
