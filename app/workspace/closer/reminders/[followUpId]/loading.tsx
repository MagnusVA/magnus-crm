import { Skeleton } from "@/components/ui/skeleton";

export default function ReminderDetailLoading() {
	return (
		<div
			className="flex flex-col gap-6"
			role="status"
			aria-label="Loading reminder"
		>
			<div className="flex items-center justify-between">
				<Skeleton className="h-9 w-20" />
				<Skeleton className="h-5 w-24 rounded-full" />
			</div>

			<div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
				<div className="flex flex-col gap-4 md:col-span-1">
					<Skeleton className="h-64 rounded-xl" />
					<Skeleton className="h-44 rounded-xl" />
				</div>
				<div className="flex flex-col gap-6 md:col-span-2 lg:col-span-3">
					<Skeleton className="h-40 rounded-xl" />
					<Skeleton className="h-32 rounded-xl" />
					<Skeleton className="h-52 rounded-xl" />
				</div>
			</div>
		</div>
	);
}
