import { Skeleton } from "@/components/ui/skeleton";

export function LeadDetailSkeleton() {
	return (
		<div
			className="flex flex-col gap-6"
			role="status"
			aria-label="Loading lead details"
		>
			{/* Back button + status badge */}
			<div className="flex items-center justify-between">
				<Skeleton className="h-9 w-20" />
				<Skeleton className="h-5 w-20 rounded-full" />
			</div>

			{/* Lead header: name, contact info, social handles */}
			<div className="flex flex-col gap-3">
				<div>
					<Skeleton className="h-8 w-56" />
					<div className="mt-1 flex flex-col gap-1">
						<Skeleton className="h-4 w-48" />
						<Skeleton className="h-4 w-32" />
					</div>
				</div>

				{/* Social handle badges */}
				<div className="flex gap-1.5">
					{Array.from({ length: 2 }).map((_, i) => (
						<Skeleton key={i} className="h-5 w-24 rounded-full" />
					))}
				</div>

				{/* Action buttons */}
				<div className="flex gap-2">
					{Array.from({ length: 3 }).map((_, i) => (
						<Skeleton key={i} className="h-9 w-28 rounded-md" />
					))}
				</div>
			</div>

			{/* Tab bar */}
			<Skeleton className="h-10 w-full max-w-lg rounded-md" />

			{/* Tab content area */}
			<div className="flex flex-col gap-4">
				<Skeleton className="h-48 rounded-xl" />
				<Skeleton className="h-32 rounded-xl" />
			</div>
		</div>
	);
}
