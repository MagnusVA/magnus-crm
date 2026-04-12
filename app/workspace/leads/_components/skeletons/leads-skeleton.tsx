import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading skeleton for the leads list page.
 *
 * Layout structure matches LeadsPageContent:
 * 1. Header row (title + subtitle + export button)
 * 2. Search + filter bar (Card with search input + tabs)
 * 3. Table rows (8 rows inside a rounded border container)
 */
export function LeadsSkeleton() {
	return (
		<div
			className="flex flex-col gap-6"
			role="status"
			aria-label="Loading leads"
		>
			{/* Header with title + export button */}
			<div className="flex items-start justify-between">
				<div className="flex flex-col gap-2">
					<Skeleton className="h-8 w-28" />
					<Skeleton className="h-5 w-72" />
				</div>
				<Skeleton className="h-9 w-28" />
			</div>

			{/* Search + filter bar */}
			<Card className="p-4">
				<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
					<Skeleton className="h-9 w-full sm:max-w-xs" />
					<Skeleton className="h-9 w-64" />
				</div>
			</Card>

			{/* Table rows */}
			<div className="overflow-hidden rounded-lg border">
				{/* Table header */}
				<div className="border-b bg-muted/50 px-4 py-3">
					<div className="flex gap-4">
						<Skeleton className="h-4 w-24" />
						<Skeleton className="h-4 w-32" />
						<Skeleton className="hidden h-4 w-20 md:block" />
						<Skeleton className="h-4 w-16" />
						<Skeleton className="h-4 w-24" />
						<Skeleton className="hidden h-4 w-24 lg:block" />
						<Skeleton className="hidden h-4 w-20 lg:block" />
					</div>
				</div>
				{/* Table body rows */}
				<div className="flex flex-col">
					{Array.from({ length: 8 }).map((_, i) => (
						<div
							key={i}
							className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0"
						>
							<Skeleton className="h-4 w-28" />
							<Skeleton className="h-4 w-36" />
							<Skeleton className="hidden h-4 w-20 md:block" />
							<Skeleton className="h-5 w-16 rounded-full" />
							<Skeleton className="h-4 w-8" />
							<Skeleton className="hidden h-4 w-24 lg:block" />
							<Skeleton className="hidden h-4 w-20 lg:block" />
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
