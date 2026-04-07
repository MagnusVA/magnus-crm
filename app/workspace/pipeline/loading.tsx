import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function PipelineLoading() {
	return (
		<div className="flex flex-col gap-6" role="status" aria-label="Loading pipeline">
			{/* Header with title + export button */}
			<div className="flex items-start justify-between">
				<div className="flex flex-col gap-2">
					<Skeleton className="h-9 w-36" />
					<Skeleton className="h-5 w-72" />
				</div>
				<Skeleton className="h-9 w-28" />
			</div>

			{/* Filters bar */}
			<Skeleton className="h-10 w-full rounded-lg" />

			{/* Table rows */}
			<Card>
				<CardContent className="pt-6">
					<div className="flex flex-col gap-4">
						{Array.from({ length: 8 }).map((_, i) => (
							<Skeleton key={i} className="h-12 w-full" />
						))}
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
