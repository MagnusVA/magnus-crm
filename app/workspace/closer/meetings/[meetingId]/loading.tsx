import { Skeleton } from "@/components/ui/skeleton";

export default function MeetingDetailLoading() {
	return (
		<div className="flex flex-col gap-4" role="status" aria-label="Loading meeting details">
			{/* Command header — back + title (left), actions (right) */}
			<div className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-2">
					<Skeleton className="h-8 w-16" />
					<Skeleton className="h-5 w-32" />
				</div>
				<div className="flex gap-2">
					{Array.from({ length: 3 }).map((_, i) => (
						<Skeleton key={i} className="h-8 w-24 rounded-md" />
					))}
				</div>
			</div>

			{/* Packed 3-column workspace */}
			<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
				<div className="flex flex-col gap-4">
					<Skeleton className="h-64 rounded-xl" />
					<Skeleton className="h-40 rounded-xl" />
				</div>
				<div className="flex flex-col gap-4">
					<Skeleton className="h-44 rounded-xl" />
					<Skeleton className="h-40 rounded-xl" />
				</div>
				<div className="flex flex-col gap-4">
					<Skeleton className="h-16 rounded-xl" />
					<Skeleton className="h-80 rounded-xl" />
				</div>
			</div>
		</div>
	);
}
