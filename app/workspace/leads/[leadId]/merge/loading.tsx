import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading skeleton for the lead merge page.
 *
 * Layout structure matches MergePageClient:
 * 1. Back link
 * 2. Page header (title + description)
 * 3. Search card area
 */
export default function MergeLoading() {
	return (
		<div
			className="flex flex-col gap-6"
			role="status"
			aria-label="Loading merge page"
		>
			{/* Back link */}
			<Skeleton className="h-9 w-28" />

			{/* Page header */}
			<div className="flex flex-col gap-2">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-5 w-96" />
			</div>

			{/* Source lead info card */}
			<Card className="p-4">
				<div className="flex items-center gap-4">
					<Skeleton className="h-10 w-10 rounded-full" />
					<div className="flex flex-col gap-2">
						<Skeleton className="h-5 w-36" />
						<Skeleton className="h-4 w-48" />
					</div>
				</div>
			</Card>

			{/* Search card area */}
			<Card className="p-6">
				<div className="flex flex-col gap-4">
					<Skeleton className="h-5 w-56" />
					<Skeleton className="h-9 w-full sm:max-w-xs" />
					{/* Placeholder result rows */}
					{Array.from({ length: 3 }).map((_, i) => (
						<div key={i} className="flex items-center gap-4 py-2">
							<Skeleton className="h-4 w-32" />
							<Skeleton className="h-4 w-48" />
							<Skeleton className="h-4 w-16" />
						</div>
					))}
				</div>
			</Card>
		</div>
	);
}
