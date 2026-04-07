import { Skeleton } from "@/components/ui/skeleton";

export default function CloserDashboardLoading() {
	return (
		<div className="flex flex-col gap-6" role="status" aria-label="Loading dashboard">
			{/* Page header */}
			<div className="flex flex-col gap-2">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-4 w-64" />
			</div>

			{/* Featured meeting card */}
			<Skeleton className="h-[180px] rounded-xl" />

			{/* Pipeline strip */}
			<div className="flex flex-col gap-3">
				<Skeleton className="h-4 w-24" />
				<div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
					{Array.from({ length: 7 }).map((_, i) => (
						<Skeleton key={i} className="h-[76px] rounded-lg" />
					))}
				</div>
			</div>

			{/* Separator */}
			<Skeleton className="h-px w-full" />

			{/* Calendar section */}
			<div className="flex flex-col gap-3">
				<Skeleton className="h-6 w-32" />
				<Skeleton className="h-[400px] rounded-xl" />
			</div>
		</div>
	);
}
