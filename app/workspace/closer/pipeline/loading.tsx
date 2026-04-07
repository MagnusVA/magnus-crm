import { Skeleton } from "@/components/ui/skeleton";

export default function CloserPipelineLoading() {
	return (
		<div className="flex flex-col gap-6" role="status" aria-label="Loading pipeline">
			{/* Page header */}
			<div className="flex flex-col gap-2">
				<Skeleton className="h-8 w-40" />
				<Skeleton className="h-4 w-72" />
			</div>

			{/* Status tabs */}
			<Skeleton className="h-9 w-full rounded-lg" />

			{/* Opportunity rows */}
			<div className="flex flex-col gap-1">
				{Array.from({ length: 5 }).map((_, i) => (
					<Skeleton key={i} className="h-14 rounded-md" />
				))}
			</div>
		</div>
	);
}
