import { Skeleton } from "@/components/ui/skeleton";

export default function MeetingDetailLoading() {
	return (
		<div className="flex flex-col gap-6" role="status" aria-label="Loading meeting details">
			{/* Back button + status badge */}
			<div className="flex items-center justify-between">
				<Skeleton className="h-9 w-20" />
				<Skeleton className="h-5 w-24 rounded-full" />
			</div>

			{/* Content grid — matches md:grid-cols-3 lg:grid-cols-4 layout */}
			<div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
				{/* Left column — lead info + history */}
				<div className="flex flex-col gap-4">
					<Skeleton className="h-48 rounded-xl" />
					<Skeleton className="h-40 rounded-xl" />
				</div>

				{/* Right columns — meeting info, answers, notes */}
				<div className="flex flex-col gap-4 md:col-span-2 lg:col-span-3">
					<Skeleton className="h-56 rounded-xl" />
					<Skeleton className="h-40 rounded-xl" />
				</div>
			</div>

			{/* Outcome action bar */}
			<div className="flex gap-3 border-t pt-4">
				{Array.from({ length: 3 }).map((_, i) => (
					<Skeleton key={i} className="h-10 w-32 rounded-md" />
				))}
			</div>
		</div>
	);
}
