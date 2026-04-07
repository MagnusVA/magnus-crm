import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function TeamLoading() {
	return (
		<div className="flex flex-col gap-6" role="status" aria-label="Loading team">
			{/* Header with title + action buttons */}
			<div className="flex items-start justify-between">
				<div className="flex flex-col gap-2">
					<Skeleton className="h-9 w-32" />
					<Skeleton className="h-5 w-64" />
				</div>
				<div className="flex gap-2">
					<Skeleton className="h-9 w-28" />
					<Skeleton className="h-9 w-32" />
				</div>
			</div>

			{/* Table rows */}
			<Card>
				<CardContent className="pt-6">
					<div className="flex flex-col gap-4">
						{Array.from({ length: 5 }).map((_, i) => (
							<Skeleton key={i} className="h-12 w-full" />
						))}
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
